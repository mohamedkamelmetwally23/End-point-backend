# TEST academic curriculum reset

From `BackEnd`, run `npm run db:reset-academic`.

**TEST/DEVELOPMENT ONLY. Destructive; no backup is created.** The command uses the existing MongoDB configuration and shared database-name allowlist, rejects production, unknown collections, and missing/ambiguous colleges. It never drops the database or creates a college/user. All deletions, inserts, reference cleanup, and validation execute in one MongoDB transaction. A replica set/Atlas deployment is required. Run during a quiet maintenance period without concurrent application writes.

The curriculum lives in `scripts/seeds/academic-curriculum.ts`. Re-running replaces the academic base again with new IDs. It preserves all college/user fields except obsolete user academic/access references, which are unset directly without changing timestamps or assigning new placement. Students whose year was cleared need an administrator to select a new year before workflows requiring placement can succeed.

The reset removes academic years, terms, subjects, packages, package subjects, lectures, materials, staff assignments, package access, orders, lecture progress, expenses, and related audit logs (by entity type or deleted IDs in entity/metadata). User/college audit logs are preserved unless they reference deleted data. Devices tied only to users and login sessions are preserved; legacy devices with academic fields are removed. Uploaded files on disk are not MongoDB records and remain on disk.

The transaction verifies unchanged college/user snapshots (allowing only reported reference removals), 4 years, 8 ordered inactive semesters, exact subject names and placement, six subjects per semester, 48 subjects total, empty content/finance/access collections, and no remaining user academic references. Orders being empty means revenue is zero. Any assertion failure rolls back. The command prints deletion counts, preserved counts, cleared user IDs/fields, and each semester's results.

Useful independent MongoDB verification queries:

```javascript
db.colleges.find({}, {name:1})
db.users.countDocuments({})
db.academic_years.find({}, {name:1, collegeId:1, order:1}).sort({order:1})
db.terms.find({}, {name:1, academicYearId:1, order:1, localOrder:1, status:1}).sort({order:1})
db.subjects.aggregate([{$group:{_id:'$termId', count:{$sum:1}}}])
db.orders.aggregate([{$match:{status:'completed'}},{$group:{_id:null,revenue:{$sum:'$priceSnapshot'}}}]) // empty = zero
for (const name of ['packages','package_subjects','lectures','materials','staff_assignments','package_access','orders','expenses','lecture_progress']) print(name, db.getCollection(name).countDocuments({}))
```

Schema changes: terms gain `order` (global semester number) and `localOrder` (1 or 2); the API accepts these fields and sorts terms by order. Existing two-term years are respected by the automatic term initializer, preventing extra default terms when a seeded year is later edited. No active semester is selected by this reset.

## Verified execution: 9 October 2026

Target: database `test`, environment `development`.

Preserved college: The Egyptian e-learning university (Eelu), ID `6ac69eb03b28276d4a31f763`. All 4 users preserved; full raw document comparison passed after allowing the one explicit reference removal below. College document comparison passed without changes.

Deleted record counts:

| Collection | Deleted |
| --- | ---: |
| academic_years | 4 |
| terms | 8 |
| subjects | 2 |
| packages | 1 |
| package_subjects | 1 |
| lectures | 1 |
| materials | 0 |
| staff_assignments | 2 |
| package_access | 1 |
| orders | 0 |
| lecture_progress | 0 |
| expenses | 2 |
| audit_logs | 25 |
| student_devices | 0 |

Created: 4 academic years, 8 semesters, 48 subjects. Semesters 1 and 2 belong to Year 1; 3 and 4 to Year 2; 5 and 6 to Year 3; 7 and 8 to Year 4. Each semester has exactly 6 subjects; all 8 are inactive. Subject names and parent relationships passed exact verification against the curriculum.

Cleared `academicYearId` from user `6ac6b1698245867b05fc87af`. No user was reassigned. All other user fields, including credentials, college references, and timestamps, were preserved.

Independent verification command: `node --import tsx scripts/verify-academic-reset.ts`.

Committed counts: colleges 1, users 4, academic_years 4, terms 8, subjects 48; packages, package_subjects, lectures, materials, staff_assignments, package_access, orders, expenses, and lecture_progress all 0. Revenue 0. Preserved 18 unrelated audit logs, 1 user-bound device, and 1 login session. No remaining user academic-year references; every seeded subject/term/year resolves to its expected parent.

Checks: `npm run typecheck`, `npm run lint`, and `npm test` passed (2 test files, 39 tests). Platform tests use a separate generated test database.
