/**
 * The Chromium sandbox on Linux, and why the app refuses to start without it.
 *
 * The dashboard window renders prompts, tool calls and tool output captured from coding agents —
 * untrusted content — so its renderer must run sandboxed. On Linux, Chromium's sandbox needs one
 * of two things from the system:
 *
 *  - **unprivileged user namespaces**, which Ubuntu 23.10+ restricts through AppArmor
 *    (`kernel.apparmor_restrict_unprivileged_userns=1`) unless a profile grants `userns` to the
 *    binary — which is what the .deb installs (`/etc/apparmor.d/traceroost-desktop`); or
 *  - a **setuid-root `chrome-sandbox`** helper, which the .deb's post-install script sets up on
 *    systems with no user namespaces at all.
 *
 * An AppImage can do neither: it cannot install an AppArmor profile, and its FUSE mount is
 * `nosuid`. electron-builder's AppImage launcher deals with that by quietly adding `--no-sandbox`
 * whenever `unshare -Ur true` fails — exactly the Ubuntu 24.04 case. The plan forbids shipping
 * that, and asks for the fallback to be chosen deliberately: **the app refuses to start, with a
 * message that says why and what to do**, rather than show untrusted content unsandboxed.
 *
 * What to do is "install the .deb". A hand-written AppArmor profile for the AppImage's binary
 * would not help: the launcher's probe runs `/usr/bin/unshare`, which such a profile does not
 * cover, so the launcher adds the switch regardless.
 *
 * The switch is visible to the main process (Chromium has not started a renderer yet), so this is
 * checked first thing in main.ts. It is not configurable: there is no flag, environment variable
 * or preference that runs the dashboard unsandboxed.
 */

export interface SandboxRefusal {
  title: string
  message: string
}

export function sandboxRefusal(opts: {
  platform: NodeJS.Platform
  /** `app.commandLine.hasSwitch('no-sandbox')`, or `--no-sandbox` in argv. */
  noSandbox: boolean
  /** `$APPIMAGE`, set by the AppImage runtime. */
  appImage: string | undefined
}): SandboxRefusal | undefined {
  if (!opts.noSandbox) return undefined
  if (opts.platform === 'linux' && opts.appImage) {
    return {
      title: 'TraceRoost cannot start safely on this system',
      message:
        'This system does not allow the TraceRoost AppImage to use the security sandbox that ' +
        'isolates its dashboard window, and TraceRoost will not run without it.\n\n' +
        'This is usually Ubuntu 23.10 or later, which only lets applications with an AppArmor ' +
        'profile use the kernel feature the sandbox needs — and an AppImage cannot install one.\n\n' +
        'Install the TraceRoost .deb instead: it installs that profile, and uses the same data, so ' +
        'nothing recorded so far is lost.\n\n' +
        'Lifting the restriction for the whole system (the kernel.apparmor_restrict_unprivileged_userns ' +
        'setting) also works, but weakens every application on the machine and is not recommended.',
    }
  }
  return {
    title: 'TraceRoost cannot start without its sandbox',
    message:
      'TraceRoost was started with --no-sandbox. Its dashboard window shows content captured from ' +
      'coding agents and must stay sandboxed, so TraceRoost does not run with that option. Start ' +
      'it without --no-sandbox.',
  }
}
