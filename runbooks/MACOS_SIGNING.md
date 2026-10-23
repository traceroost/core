# macOS signing and notarization

**Trigger:** the Apple Developer Program membership is approved (first time), or the Developer ID
certificate, the notarization credentials or the membership needs renewing (see
[Keeping it working](#keeping-it-working)).

Everything in the build is already wired: [`desktop/electron-builder.cjs`](../desktop/electron-builder.cjs)
signs with a Developer ID under the hardened runtime and notarizes when the environment has the
credentials, and [`.github/workflows/desktop-macos.yml`](../.github/workflows/desktop-macos.yml)
maps repository secrets onto that environment. Turning it on is creating five secrets and checking
the result; there is no code change. Until then every macOS build is ad-hoc signed and releases
attach it as `*-preview`.

The hardened-runtime path has been rehearsed with a self-signed identity
(`cd desktop && pnpm run pack:host && pnpm run rehearse:mac-signing`): the app, its collector child
and the WASM it loads all run under the production entitlements. Re-run that after changing the
entitlements or anything the collector spawns.

The membership is an **individual** one, so the certificate, the notarization record and the
macOS dialogs that name a developer say **Roger Reed**, not TraceRoost. Moving to an organization
later (it needs a legal entity and a D-U-N-S number) means a new certificate and new secrets — this
same procedure again — and no code change.

## 1. Note the Team ID

[developer.apple.com/account](https://developer.apple.com/account) → **Membership details** →
**Team ID** (10 characters, e.g. `A1B2C3D4E5`). It is the `APPLE_TEAM_ID` secret below, and the
`(…)` at the end of the certificate's name.

## 2. Create the Developer ID Application certificate

Only the Account Holder can create Developer ID certificates — on an individual membership, that is
you. Do this on a Mac you control; the private key is generated there and never leaves it except in
the `.p12` of step 3.

1. **Keychain Access** → menu **Keychain Access → Certificate Assistant → Request a Certificate From
   a Certificate Authority…** → your email, common name `Roger Reed`, **Saved to disk**. This writes
   a `.certSigningRequest` and puts the private key in the login keychain.
2. [Certificates, Identifiers & Profiles → Certificates](https://developer.apple.com/account/resources/certificates/list)
   → **+** → **Developer ID Application** (not *Installer*, not *Apple Distribution*) → profile type
   **G2 Sub-CA** → upload the request → **Download** the `.cer`.
3. Double-click the `.cer`. It joins its private key in the login keychain. Check:

   ```sh
   security find-identity -v -p codesigning
   #  1) 4F…E2 "Developer ID Application: Roger Reed (A1B2C3D4E5)"
   ```

   Not listed, or listed without `-v`'s blessing? The private key is not on this Mac (the request was
   made on another one) or Apple's intermediate is missing — install
   [Developer ID - G2](https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer) and look again.

## 3. Export the `.p12` for CI

Keychain Access → **login** → **My Certificates** → the *Developer ID Application: Roger Reed* entry
(expand it: the private key must be underneath) → right-click → **Export…** → `.p12`, with a long
random password.

Keep the `.p12` and its password in your password manager. It is the only copy of the private key
besides this Mac's keychain; lose both and the certificate has to be revoked and reissued.

## 4. Choose notarization credentials

Either works; the config prefers the API key when both are set.

- **Apple ID + app-specific password** (simplest on an individual membership).
  [account.apple.com](https://account.apple.com) → **Sign-In and Security → App-Specific
  Passwords** → **+** → name it `traceroost-notarize`. Changing the Apple Account password revokes
  every app-specific password, so this needs redoing after one.
- **App Store Connect API key.** [App Store Connect → Users and Access → Integrations → App Store
  Connect API](https://appstoreconnect.apple.com/access/integrations/api) → **Team Keys** → **+** →
  access **Developer** → download the `.p8` (once only) and note the **Key ID** and the **Issuer
  ID**. If Team Keys are not offered on the account, use the Apple ID route.

## 5. Sign and notarize once locally

Before giving CI the secrets, prove the credentials on this Mac. `CSC_NAME` is the certificate's
name **without** the `Developer ID Application: ` prefix (electron-builder refuses the prefix):

```sh
cd desktop
env -u ELECTRON_RUN_AS_NODE \
  CSC_NAME="Roger Reed (A1B2C3D4E5)" \
  APPLE_ID="you@example.com" APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop" APPLE_TEAM_ID="A1B2C3D4E5" \
  pnpm run pack:host
```

(Or `APPLE_API_KEY=/path/AuthKey_XXXX.p8 APPLE_API_KEY_ID=… APPLE_API_ISSUER=…` in place of the
three `APPLE_*`.) Do not use `CSC_LINK` with a `.p12`: electron-builder 26.15.3 unlocks its
temporary keychain with the wrong password and fails at `set-key-partition-list` (see the header of
`desktop-macos.yml`). Notarization uploads the app and waits for Apple, usually a few minutes.

The first build prompts once for keychain access to the private key; choose **Always Allow**.

Then:

```sh
app=dist/mac-arm64/TraceRoost.app
codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --verbose=2 "$app" 2>&1 | grep -E 'Authority=Developer ID|TeamIdentifier|flags'   # flags include `runtime`
xcrun stapler validate "$app"                                    # The validate action worked!
spctl --assess --type execute --verbose=2 "$app"                 # accepted, source=Notarized Developer ID
pnpm run smoke                                                   # the signed app, with real library validation
```

## 6. Add the repository secrets

```sh
base64 -i DeveloperID.p12 | gh secret set MAC_CSC_LINK --repo traceroost/core
gh secret set MAC_CSC_KEY_PASSWORD --repo traceroost/core          # paste the .p12 password
# Apple ID route:
gh secret set APPLE_ID --repo traceroost/core
gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo traceroost/core
gh secret set APPLE_TEAM_ID --repo traceroost/core --body A1B2C3D4E5
# …or the API-key route instead of the first two:
gh secret set APPLE_API_KEY_P8 --repo traceroost/core < AuthKey_XXXX.p8
gh secret set APPLE_API_KEY_ID --repo traceroost/core
gh secret set APPLE_API_ISSUER --repo traceroost/core
```

Set `APPLE_TEAM_ID` on the API-key route too: the Notarization check then also asserts that the app
was signed by that team. Add the certificate and the notarization credentials together — with only
one of them the Notarization check fails the build on purpose.

## 7. Verify in CI

**Actions → Desktop (macOS) → Run workflow** on `main`. Expect:

- *Import the Developer ID certificate* lists one valid `Developer ID Application: Roger Reed (…)`
  identity;
- *Build and package* logs `notarization successful` for both architectures;
- *Notarization check* passes (Developer ID authority, hardened runtime, Team ID, stapled ticket,
  `spctl` accepted) and the step outputs `notarized=true`.

Failures and what they mean:

| Error | Cause |
| --- | --- |
| `MAC_CSC_LINK holds no valid 'Developer ID Application' identity` | wrong certificate type, wrong password, or exported without its private key (step 3) |
| `Apple signing is half configured` | the certificate or the notarization secrets are missing |
| notarization `Invalid` / `status: Invalid` | `xcrun notarytool log <submission id> …` names the binary; usually an unsigned Mach-O inside the bundle or a missing hardened runtime |
| `HTTP 401` / `Unable to authenticate` | the app-specific password or API key is wrong, revoked, or for another team |

## 8. First release and the Gatekeeper test

The next `v*` tag attaches `TraceRoost-<v>-mac-{arm64,x64}.dmg` under their plain names instead of
`*-preview` — nothing to switch ([`RELEASING.md` → Desktop](RELEASING.md)). Before announcing it:

1. On a **different macOS user account** (or another Mac), download the DMG from the release page
   in a browser, so it carries the quarantine flag (`xattr -p com.apple.quarantine <dmg>` prints
   one).
2. Open it, drag TraceRoost to Applications, open it. The only prompt should be *"TraceRoost is an
   app downloaded from the Internet. Are you sure you want to open it?"* — no "cannot be verified",
   no trip to System Settings.
3. Then update the install text in `desktop/README.md` (*Installing*) to drop the unsigned-build
   instructions.

## Keeping it working

| What | Lifetime | If it lapses |
| --- | --- | --- |
| Apple Developer Program membership | 1 year, renews yearly (US$99) | new builds cannot be notarized; releases fall back to `*-preview`. Builds already notarized keep opening |
| Developer ID Application certificate | 5 years | same as above until a new one is made (steps 2, 3, 6). Software signed before expiry keeps working — the signature is timestamped |
| App-specific password | until revoked, or the Apple Account password changes | notarization fails with 401 (step 4, then `APPLE_APP_SPECIFIC_PASSWORD`) |
| App Store Connect API key | until revoked | notarization fails with 401 |

A Developer ID certificate that leaks must be **revoked** (developer.apple.com → Certificates →
Revoke), which also invalidates everything signed after the revocation date; then start again from
step 2.
