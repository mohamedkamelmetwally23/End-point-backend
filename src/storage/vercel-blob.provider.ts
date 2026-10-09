import {
  del,
  get,
  head,
  issueSignedToken,
  presignUrl,
  put,
} from "@vercel/blob";
import {
  handleUploadPresigned,
  type HandleUploadPresignedBody,
} from "@vercel/blob/client";
import type { Request } from "express";
import { ensure, ApiError } from "../shared/errors.js";

export type Visibility = "public" | "private";
function options(access: Visibility) {
  const prefix = access === "public" ? "PUBLIC" : "PRIVATE";
  const storeId = process.env[`BLOB_${prefix}_STORE_ID`];
  const token = process.env[`BLOB_${prefix}_READ_WRITE_TOKEN`];
  ensure(
    (storeId && process.env.VERCEL_OIDC_TOKEN) || token,
    503,
    "STORAGE_UNAVAILABLE",
  );
  // OIDC is resolved/refreshed by the SDK on Vercel. Static tokens support local use.
  return storeId && process.env.VERCEL_OIDC_TOKEN
    ? { storeId }
    : { ...(token ? { token } : {}), ...(storeId ? { storeId } : {}) };
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "BlobNotFoundError")
      throw new ApiError(404, "FILE_NOT_FOUND");
    throw new ApiError(503, "STORAGE_UNAVAILABLE");
  }
}
export const blobProvider = {
  async authorizeUpload(
    req: Request,
    pathname: string,
    access: Visibility,
    mimeType: string,
    size: number,
  ) {
    return safe(() =>
      handleUploadPresigned({
        request: req,
        body: req.body as HandleUploadPresignedBody,
        getSignedToken: async (requested, _payload, multipart) => {
          ensure(requested === pathname && !multipart, 400, "INVALID_UPLOAD");
          const limits = {
            pathname,
            operations: ["put" as const],
            validUntil: Date.now() + 10 * 60000,
            allowedContentTypes: [mimeType],
            maximumSizeInBytes: size,
          };
          return {
            token: await issueSignedToken({ ...options(access), ...limits }),
            urlOptions: {
              allowedContentTypes: [mimeType],
              maximumSizeInBytes: size,
              allowOverwrite: false,
              addRandomSuffix: false,
            },
          };
        },
      }),
    );
  },
  head: (pathname: string, access: Visibility) =>
    safe(() => head(pathname, options(access))),
  get: (pathname: string, access: Visibility) =>
    safe(() => get(pathname, { ...options(access), access, useCache: false })),
  delete: (pathname: string, access: Visibility) =>
    safe(() => del(pathname, options(access))),
  put: (
    pathname: string,
    bytes: Buffer,
    access: Visibility,
    contentType: string,
  ) =>
    safe(() =>
      put(pathname, bytes, {
        ...options(access),
        access,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: false,
      }),
    ),
  async download(pathname: string) {
    return safe(async () => {
      const token = await issueSignedToken({
        ...options("private"),
        pathname,
        operations: ["get"],
        validUntil: Date.now() + 60000,
      });
      return (
        await presignUrl(token, {
          operation: "get",
          pathname,
          access: "private",
          useCache: false,
        })
      ).presignedUrl;
    });
  },
};
