import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'child_process'
import {
  generateSystemdUnit, SYSTEMD_UNIT_NAME, serviceLogPath, type ServiceProgram,
} from '../../src/serviceConfig'
import { probeServiceHealth } from './health'

function unitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME)
}

function systemctl(...args: string[]): void {
  execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' })
}

export function isInstalled(): boolean {
  return fs.existsSync(unitPath())
}

export function install(program: ServiceProgram): void {
  fs.mkdirSync(path.dirname(unitPath()), { recursive: true })
  fs.mkdirSync(path.dirname(serviceLogPath(program.config)), { recursive: true })
  fs.writeFileSync(unitPath(), generateSystemdUnit(program), 'utf-8')
  systemctl('daemon-reload')
  systemctl('enable', SYSTEMD_UNIT_NAME)
  // `restart`, not `enable --now`: --now only starts a stopped unit, so re-running install to
  // change ports/data-dir left the old process running on the old ports. restart starts a stopped
  // unit too, so this covers the first install as well.
  systemctl('restart', SYSTEMD_UNIT_NAME)
}

export function uninstall(): void {
  try { systemctl('disable', '--now', SYSTEMD_UNIT_NAME) } catch { /* already stopped/disabled */ }
  try { fs.rmSync(unitPath()) } catch { /* already removed */ }
  try { systemctl('daemon-reload') } catch { /* nothing to reload */ }
}

export function start(): void {
  systemctl('start', SYSTEMD_UNIT_NAME)
}

export function stop(): void {
  systemctl('stop', SYSTEMD_UNIT_NAME)
}

export function restart(): void {
  systemctl('restart', SYSTEMD_UNIT_NAME)
}

export async function status(uiPort: number, bindHost: string): Promise<boolean> {
  return probeServiceHealth(uiPort, bindHost)
}

export function logsPath(program: ServiceProgram): string {
  return serviceLogPath(program.config)
}
