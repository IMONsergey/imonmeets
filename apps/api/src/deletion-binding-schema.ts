/** Database authority pin is included in every subsequent database backup. */
export const deletionBindingSchema = `
CREATE TABLE IF NOT EXISTS im_deletion_journal_binding (
 singleton smallint PRIMARY KEY DEFAULT 1 CHECK(singleton=1),
 journal_id text NOT NULL CHECK(journal_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 genesis_sha256 text NOT NULL CHECK(genesis_sha256 ~ '^[a-f0-9]{64}$'),
 enrollment_mode text NOT NULL CHECK(enrollment_mode IN ('empty-database','reviewed-baseline')),
 baseline_approval_sha256 text CHECK(baseline_approval_sha256 ~ '^[a-f0-9]{64}$'),
 bound_at timestamptz NOT NULL DEFAULT now(),
 CHECK((enrollment_mode='empty-database' AND baseline_approval_sha256 IS NULL)
    OR (enrollment_mode='reviewed-baseline' AND baseline_approval_sha256 IS NOT NULL))
);
`;
