# SUCCESSION

## Emergency Credential Holder

In the unlikely event that the primary maintainer is unavailable for more than 90 days, the following individual has been designated as the emergency credential holder for the SigMap project:

- **Name:** Jane Doe
- **GitHub Username:** `janedoe`
- **Email:** `janedoe@example.com`
- **NPM Token:** Stored in the organization’s secret vault and can be accessed by the emergency holder.

The emergency holder has **read‑only** access to the repository and can publish a new release or transfer ownership if required. No code changes are needed to use this document; it serves as a public, auditable record for enterprises and auditors.

## Transfer Procedure
1. Verify the primary maintainer has been unresponsive for 90 days.
2. The emergency holder creates a pull request updating the `package.json` version and publishing to npm.
3. The emergency holder adds themselves as an owner of the GitHub organization (once the repo is migrated).
4. Document the hand‑off in the repository’s `CHANGELOG.md`.

## Governance
- This document is part of the **Phase‑1** governance deliverables.
- It will be reviewed annually and updated as personnel changes.
