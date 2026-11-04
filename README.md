# Nemo Admin

Local Next.js application with MySQL-backed administrator login and a protected dashboard.

See [SETUP.txt](./SETUP.txt) for local database details, commands, current scope and aaPanel deployment steps. Start the development server with `npm run dev`; run migrations with `npm run db:migrate`. Create an administrator with `npm run admin:create`.

Customer management, license creation/extension/revocation, device release and audit views are implemented. Signed device activation/verification APIs can provision the optional pair of Nemo IDs after activation; see docs/LICENSE-API.txt.

The installation portal and private signing worker support Apple codesign on macOS and a pinned zsign build on Linux. See docs/INSTALLATION-LOCAL.txt and docs/DEPLOYMENT-LINUX.txt for validation results, prerequisites and the deployment procedure. VPS deployment has not been performed.
