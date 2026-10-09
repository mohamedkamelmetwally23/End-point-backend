import { it, expect, vi, afterEach } from "vitest";
import type { Request } from "express";
vi.mock("@vercel/blob", () => ({
  issueSignedToken: vi.fn(async () => ({
    delegationToken: "delegation",
    clientSigningToken: "signer",
    validUntil: Date.now() + 60000,
  })),
  presignUrl: vi.fn(async () => ({
    presignedUrl: "https://private.blob.vercel-storage.com/file?signature=test",
  })),
  head: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock("@vercel/blob/client", () => ({
  handleUploadPresigned: vi.fn(async (options) =>
    options.getSignedToken(
      options.body.payload.pathname,
      null,
      options.body.payload.multipart ?? false,
    ),
  ),
}));
import { issueSignedToken, presignUrl } from "@vercel/blob";
import { blobProvider } from "../src/storage/vercel-blob.provider.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("uses managed OIDC with separate store IDs and restricts direct upload to one key/type/size", async () => {
  vi.stubEnv("VERCEL_OIDC_TOKEN", "managed-by-platform");
  vi.stubEnv("BLOB_PRIVATE_STORE_ID", "private-id");
  const req = {
    body: {
      type: "blob.generate-presigned-url",
      payload: { pathname: "private/file.pdf", multipart: false },
    },
  } as Request;
  const start = Date.now();
  await blobProvider.authorizeUpload(
    req,
    "private/file.pdf",
    "private",
    "application/pdf",
    20 * 1024 * 1024,
  );
  expect(issueSignedToken).toHaveBeenCalledWith(
    expect.objectContaining({
      storeId: "private-id",
      pathname: "private/file.pdf",
      operations: ["put"],
      maximumSizeInBytes: 20 * 1024 * 1024,
      allowedContentTypes: ["application/pdf"],
    }),
  );
  const options = vi.mocked(issueSignedToken).mock.calls[0]![0];
  expect(options).not.toHaveProperty("token");
  expect(options).not.toHaveProperty("oidcToken");
  expect(options.validUntil! - start).toBeLessThanOrEqual(10 * 60000 + 1000);
  req.body.payload.pathname = "other.pdf";
  await expect(
    blobProvider.authorizeUpload(
      req,
      "private/file.pdf",
      "private",
      "application/pdf",
      100,
    ),
  ).rejects.toThrow("INVALID_UPLOAD");
});
it("signs private downloads for one minute, avoiding Function response limits", async () => {
  vi.stubEnv("BLOB_PRIVATE_READ_WRITE_TOKEN", "local-secret");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  const start = Date.now();
  await blobProvider.download("private/file.pdf");
  expect(issueSignedToken).toHaveBeenCalledWith(
    expect.objectContaining({
      pathname: "private/file.pdf",
      operations: ["get"],
      token: "local-secret",
    }),
  );
  expect(
    vi.mocked(issueSignedToken).mock.calls[0]![0].validUntil! - start,
  ).toBeLessThanOrEqual(61000);
  expect(presignUrl).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      access: "private",
      operation: "get",
      pathname: "private/file.pdf",
    }),
  );
});
it("does not leak provider errors or credentials", async () => {
  vi.stubEnv("BLOB_PRIVATE_READ_WRITE_TOKEN", "");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  await expect(blobProvider.download("private/file.pdf")).rejects.toThrow(
    "STORAGE_UNAVAILABLE",
  );
  vi.stubEnv("BLOB_PRIVATE_READ_WRITE_TOKEN", "secret");
  vi.mocked(issueSignedToken).mockRejectedValueOnce(
    new Error("secret private credential"),
  );
  await expect(blobProvider.download("private/file.pdf")).rejects.toThrow(
    /^STORAGE_UNAVAILABLE$/,
  );
});
