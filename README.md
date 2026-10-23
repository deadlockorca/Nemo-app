# Nemo Admin

Local Next.js application with MySQL-backed administrator login and a protected dashboard.

See [SETUP.txt](./SETUP.txt) for local database details, commands, current scope and aaPanel deployment steps. Start the development server with `npm run dev`; run migrations with `npm run db:migrate`. Create an administrator with `npm run admin:create`.

Customer management, license creation/extension/revocation, device release and audit views are implemented. Signed device activation/verification APIs are available; see docs/LICENSE-API.txt. IPA integration and VPS deployment are not implemented yet.
