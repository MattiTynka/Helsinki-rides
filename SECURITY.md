# Security policy

Helsinki-rides is an experimental public browser beta. There is no supported
stable release or guaranteed response time yet.
Security fixes target the current main branch. Maintainers must reassess this
policy when a tagged release or hosted service is introduced.

## Reporting

Use GitHub's **Report a vulnerability** feature on
`MattiTynka/Helsinki-rides` when it is enabled. If it is unavailable, contact the
repository owner through an existing private channel. Collaborators should
arrange a confidential report directly with the owner.
There is currently no published security email address.

Do not place exploit details, credentials or personal information in a public
issue. Describe the affected version or commit, expected and observed behavior,
minimal reproduction steps and impact. Use harmless test data. Never test
against another person's account, device or deployment without authorization.

## Current boundaries

The game is a client-side application with an offline-authored world. Repository
privacy does not make a deployed website or publicly served asset URL private.
Review access control and hosting configuration separately before deployment.
Anything bundled into a browser build is downloadable by its users, including
configuration and assets; no secret belongs in a client build.

Treat downloaded GLB, texture, map and manifest data as untrusted inputs. Keep
format validation, size/hash checks and declared origin boundaries when changing
the loader or asset pipeline. Do not enable embedded scripts in third-party
Blender files. Keep authoring tools local to their intended trusted inputs.

Report a suspected credential exposure immediately to the owner, revoke or rotate
the credential, and remove it from both files and published history/artifacts.
Do not copy its value into a report or log.
