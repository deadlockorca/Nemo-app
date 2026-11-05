# Nemo Admin

Local Next.js application with MySQL-backed administrator login and a protected dashboard.

For a new chat or maintainer, start with [PROJECT-HANDOFF.txt](./docs/PROJECT-HANDOFF.txt): project context, authorization statements, verified IPA baseline, compatibility requirements and update workflow.

See [SETUP.txt](./SETUP.txt) for local database details, commands, current scope and aaPanel deployment steps. Start the development server with `npm run dev`; run migrations with `npm run db:migrate`. Create an administrator with `npm run admin:create`.

Customer management, license creation/extension/revocation, device release and audit views are implemented. Signed device activation/verification APIs can provision the optional pair of Nemo IDs after activation; see docs/LICENSE-API.txt.

The installation portal and private signing worker support Apple codesign on macOS and a pinned zsign build on Linux. See docs/INSTALLATION-LOCAL.txt and docs/DEPLOYMENT-LINUX.txt for validation results, prerequisites and the deployment procedure. Deployment evidence and its limits are recorded in docs/PROJECT-HANDOFF.txt; verify the live server before assuming its current state.

Shared, versioned blank IPA sources are managed at `/admin/ipa-library` and reused when creating customer installations. Apply migration 009 before running this version; see [IPA-LIBRARY.txt](./docs/IPA-LIBRARY.txt). Existing installations and license contracts remain supported.
