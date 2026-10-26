# Windows code signing

How the Windows desktop app is Authenticode-signed, how to switch signing off and on, and what to do
when Azure refuses to sign. The configuration itself is described in
[`desktop/README.md`](../desktop/README.md) → Windows; this is the operating procedure.

**Current state (2026-10-26): paused.** Azure Artifact Signing began answering `403 Forbidden` on
2026-10-23, and the owner chose to leave signing off for now. The repository variable
`TRACEROOST_WINDOWS_SIGNING=off` is set, so every build — including a release — is unsigned and
attached under its plain name; SmartScreen warns on first run (**More info → Run anyway**), and the
release notes say so. Update this line when signing is switched back on.

## How it works

- `desktop-windows.yml` signs when either a `.pfx` (`WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`) or the
  three Azure service-principal secrets (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
  `AZURE_CLIENT_SECRET`) are set, unless the repository variable `TRACEROOST_WINDOWS_SIGNING` is
  `off`.
- The Azure account (`TraceRoost`, endpoint `https://eus.codesigning.azure.net/`), certificate
  profile (`traceroost-public`) and publisher (`Roger Reed`) are fixed in
  `desktop/electron-builder.cjs`; they are not secrets.
- **With signing configured, an unsigned executable fails the build.** There is no silent fallback:
  a broken signature turns a pull request's Windows check red, and on a `v*` tag it means no
  Windows installer is attached and `publish-winget` has nothing to submit.

## Pause signing (before a release, or when it starts failing)

```bash
gh variable set TRACEROOST_WINDOWS_SIGNING --body off --repo traceroost/core
```

The secrets stay in place. The next build is unsigned, `signed` comes out `false`, and a release
attaches it unsigned with the SmartScreen note. Re-run any red Windows job; it will pass.

## Resume signing

1. Fix whatever made Azure refuse (below), then prove it on a branch **before** deleting the
   variable for everyone: run `Desktop (Windows)` by hand (`workflow_dispatch`) on a branch where
   you have temporarily removed the `TRACEROOST_WINDOWS_SIGNING` check — or simply delete the
   variable and run the workflow on `main` with no tag pending, watching the `package` jobs.
2. ```bash
   gh variable delete TRACEROOST_WINDOWS_SIGNING --repo traceroost/core
   ```
3. Confirm a green `Desktop (Windows)` run on `main` whose log shows `Submitting digest for
   signing...` followed by a signature check, not a SignTool error.
4. Update **Current state** above and the open-items list in `desktop/README.md`.

## Triage a `403 Forbidden`

The failing log looks like this (`package (x64, windows-latest)` and the arm64 job alike):

```
Azure.RequestFailedException: Service request failed.
Status: 403 (Forbidden)
   at Azure.CodeSigning.CertificateProfileRestClient.SignAsync(...)
SignTool Error: An unexpected internal error has occurred.
```

A 403 means Azure authenticated the service principal and then refused it. Check, in order:

1. **The client secret expired or was rotated.** Microsoft Entra ID → App registrations → the
   signing app → *Certificates & secrets*. A secret's lifetime is 24 months at most. If it's
   expired, or the value in GitHub isn't the current one, rotate it (below). (An expired secret
   usually fails earlier, at token acquisition, with `AADSTS7000222`; a 403 at signing is more
   often step 2 — but check the date first, it's the cheapest.)
2. **The role assignment is missing.** Azure portal → the Artifact Signing account `TraceRoost` →
   *Access control (IAM)* → *Role assignments*. The service principal needs **Artifact Signing
   Certificate Profile Signer** on the account (or on the `traceroost-public` profile). Re-add it if
   it's gone; assignments can take a few minutes to apply.
3. **The certificate profile isn't usable.** In the account, *Certificate profiles* →
   `traceroost-public` must be *Active*. A profile whose identity validation lapsed or was revoked
   refuses every signing request with 403; re-validation is done in the portal and can take days.
4. **The account or subscription is suspended or out of quota.** Check the subscription's billing
   status and the account's overview page.
5. **Wrong tenant or app.** `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` must be the app's
   *Directory (tenant) ID* and *Application (client) ID* from its Overview page.

You can't read the secret values back from GitHub; when in doubt, set all three again.

## Rotate the client secret

1. Entra ID → App registrations → the signing app → *Certificates & secrets* → *New client secret*.
   Pick the longest expiry your policy allows (24 months) and **write the expiry date into the
   owner's calendar** a month early.
2. Copy the secret's *Value* (shown once), then:

   ```bash
   gh secret set AZURE_CLIENT_SECRET --repo traceroost/core      # paste the value at the prompt
   ```

3. Run `Desktop (Windows)` by hand and confirm both architectures sign.
4. Delete the old secret in Entra ID once the new one has signed a build.

## A `.pfx` instead of Azure

If Azure stays unavailable, a conventional code-signing certificate works with no code change:
`WIN_CSC_LINK` (base64 of the `.pfx`) and `WIN_CSC_KEY_PASSWORD`. Azure takes precedence when both
are set, so delete the three `AZURE_*` secrets when switching. An OV certificate starts with no
SmartScreen reputation either; it builds up over downloads.

## Verify

- `Desktop (Windows)` green on `main` with signing on (or off, as intended).
- On a release, the Windows installers are attached and the release notes carry the SmartScreen
  section exactly when signing is off.
- A downloaded installer's *Properties → Digital Signatures* tab shows `Roger Reed` when signing is
  on.
