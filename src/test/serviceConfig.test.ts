import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  defaultServiceConfig, serviceConfigPath, readServiceConfig, writeServiceConfig,
  serviceLogPath, parseServiceInstallFlags, isRunningFromNpx,
  childEnvForReexec, shouldBlockRepeatedBootstrap, REEXEC_GUARD_ENV,
  generateLaunchdPlist, generateSystemdUnit, generateWindowsWrapperScript,
  launchdLabel, SYSTEMD_UNIT_NAME, WINDOWS_TASK_NAME,
  generateAuthToken, ensureAuthToken,
  describeNpmFailure, couldNotDownloadMessage, describeServiceManagerFailure,
  type ServiceProgram,
} from '../serviceConfig'

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-service-test-'))
}

suite('serviceConfig', () => {
  suite('defaultServiceConfig', () => {
    test('defaults to the standard ports and ~/.traceroost under the given home dir', () => {
      const home = tmpHome()
      const config = defaultServiceConfig(home)
      assert.strictEqual(config.uiPort, 3000)
      assert.strictEqual(config.otlpPort, 4318)
      assert.strictEqual(config.mcpPort, 4316)
      assert.strictEqual(config.bindHost, '127.0.0.1')
      assert.strictEqual(config.dataDir, path.join(home, '.traceroost'))
    })
  })

  suite('readServiceConfig / writeServiceConfig', () => {
    test('returns defaults when no config file exists yet', () => {
      const home = tmpHome()
      const config = readServiceConfig(home)
      assert.deepStrictEqual(config, defaultServiceConfig(home))
    })

    test('round-trips a written config, including custom values', () => {
      const home = tmpHome()
      const written = { ...defaultServiceConfig(home), uiPort: 3001, dataDir: '/custom/data' }
      writeServiceConfig(written, home)
      const read = readServiceConfig(home)
      assert.deepStrictEqual(read, written)
    })

    test('fills in missing fields from defaults if the file is a partial object', () => {
      const home = tmpHome()
      fs.mkdirSync(path.dirname(serviceConfigPath(home)), { recursive: true })
      fs.writeFileSync(serviceConfigPath(home), JSON.stringify({ uiPort: 9999 }), 'utf-8')
      const read = readServiceConfig(home)
      assert.strictEqual(read.uiPort, 9999)
      assert.strictEqual(read.otlpPort, 4318)
    })

    test('falls back to defaults if the file is corrupt JSON', () => {
      const home = tmpHome()
      fs.mkdirSync(path.dirname(serviceConfigPath(home)), { recursive: true })
      fs.writeFileSync(serviceConfigPath(home), 'not valid json{{{', 'utf-8')
      assert.deepStrictEqual(readServiceConfig(home), defaultServiceConfig(home))
    })
  })

  suite('generateAuthToken', () => {
    test('generates a non-empty, sufficiently long token', () => {
      const token = generateAuthToken()
      assert.ok(token.length >= 32)
    })

    test('generates a different token each call', () => {
      assert.notStrictEqual(generateAuthToken(), generateAuthToken())
    })
  })

  suite('ensureAuthToken', () => {
    test('generates and persists a token when the config has none', () => {
      const home = tmpHome()
      const config = defaultServiceConfig(home)
      assert.strictEqual(config.authToken, '')
      const updated = ensureAuthToken(config, home)
      assert.ok(updated.authToken.length > 0)
      assert.deepStrictEqual(readServiceConfig(home).authToken, updated.authToken)
    })

    test('leaves an existing token untouched', () => {
      const home = tmpHome()
      const withToken = { ...defaultServiceConfig(home), authToken: 'already-set' }
      writeServiceConfig(withToken, home)
      const result = ensureAuthToken(withToken, home)
      assert.strictEqual(result.authToken, 'already-set')
    })

    test('a restart reuses the persisted token instead of generating a new one', () => {
      const home = tmpHome()
      const first = ensureAuthToken(readServiceConfig(home), home)
      const second = ensureAuthToken(readServiceConfig(home), home)
      assert.strictEqual(first.authToken, second.authToken)
    })
  })

  suite('serviceLogPath', () => {
    test('lives under dataDir/logs/service.log', () => {
      const config = defaultServiceConfig('/home/user')
      assert.strictEqual(serviceLogPath(config), path.join(config.dataDir, 'logs', 'service.log'))
    })
  })

  suite('parseServiceInstallFlags', () => {
    test('parses all recognized flags', () => {
      const config = parseServiceInstallFlags([
        '--ui-port', '3001', '--otlp-port', '4319', '--mcp-port', '4317',
        '--bind-host', '0.0.0.0', '--data-dir', '/tmp/traceroost-data',
      ])
      assert.strictEqual(config.uiPort, 3001)
      assert.strictEqual(config.otlpPort, 4319)
      assert.strictEqual(config.mcpPort, 4317)
      assert.strictEqual(config.bindHost, '0.0.0.0')
      assert.strictEqual(config.dataDir, '/tmp/traceroost-data')
    })

    test('falls back to defaults for any flag not passed', () => {
      const config = parseServiceInstallFlags(['--ui-port', '3005'])
      assert.strictEqual(config.uiPort, 3005)
      assert.strictEqual(config.otlpPort, 4318)
    })

    test('ignores unknown flags', () => {
      const config = parseServiceInstallFlags(['--bogus', 'value', '--ui-port', '3005'])
      assert.strictEqual(config.uiPort, 3005)
    })

    test('ignores a non-numeric value for a numeric flag', () => {
      const config = parseServiceInstallFlags(['--ui-port', 'not-a-number'])
      assert.strictEqual(config.uiPort, 3000)
    })

    test('ignores a flag with no following value', () => {
      const config = parseServiceInstallFlags(['--ui-port'])
      assert.strictEqual(config.uiPort, 3000)
    })
  })

  suite('isRunningFromNpx', () => {
    test('detects npx via the npm user-agent string', () => {
      assert.strictEqual(isRunningFromNpx('npm/10.0.0 node/v24 npx/10.0.0', '/some/path/cli.js'), true)
    })

    test('detects npx via a _npx cache path when the user-agent is missing', () => {
      assert.strictEqual(isRunningFromNpx(undefined, '/Users/x/.npm/_npx/abc123/node_modules/.bin/traceroost'), true)
    })

    test('returns false for a normal global-install path and user-agent', () => {
      assert.strictEqual(isRunningFromNpx('npm/10.0.0 node/v24', '/usr/local/lib/node_modules/traceroost/standalone/cli.js'), false)
    })
  })

  suite('childEnvForReexec / shouldBlockRepeatedBootstrap', () => {
    test('strips npm_config_user_agent so a re-exec\'d child does not see itself as still running via npx', () => {
      const parentEnv = { PATH: '/usr/bin', npm_config_user_agent: 'npm/10.0.0 node/v24 npx/10.0.0' }
      const childEnv = childEnvForReexec(parentEnv)
      assert.strictEqual(childEnv.npm_config_user_agent, undefined)
      assert.strictEqual(childEnv.PATH, '/usr/bin')
    })

    test('stamps the re-exec guard marker', () => {
      const childEnv = childEnvForReexec({})
      assert.strictEqual(childEnv[REEXEC_GUARD_ENV], '1')
    })

    test('shouldBlockRepeatedBootstrap is false without the marker', () => {
      assert.strictEqual(shouldBlockRepeatedBootstrap({}), false)
    })

    test('shouldBlockRepeatedBootstrap is true once childEnvForReexec has stamped the marker', () => {
      const childEnv = childEnvForReexec({ npm_config_user_agent: 'npm/10.0.0 npx/10.0.0' })
      assert.strictEqual(shouldBlockRepeatedBootstrap(childEnv), true)
    })

    test('regression: without stripping, a naive re-exec would loop forever detecting npx again', () => {
      // This is the exact bug: execFileSync inherits the parent env by default, so re-invoking
      // `traceroost service install` without childEnvForReexec would carry the stale npx user-agent
      // straight through, and isRunningFromNpx would trigger another bootstrap indefinitely.
      const parentEnv = { npm_config_user_agent: 'npm/10.0.0 node/v24 npx/10.0.0' }
      assert.strictEqual(isRunningFromNpx(parentEnv.npm_config_user_agent, '/usr/local/bin/traceroost'), true)
      const fixedChildEnv = childEnvForReexec(parentEnv)
      assert.strictEqual(isRunningFromNpx(fixedChildEnv.npm_config_user_agent, '/usr/local/bin/traceroost'), false)
    })
  })

  suite('generateLaunchdPlist', () => {
    test('embeds the node path, cli path, ports, and log path', () => {
      const program: ServiceProgram = {
        nodePath: '/usr/local/bin/node',
        cliPath: '/usr/local/lib/node_modules/traceroost/standalone/cli.js',
        config: defaultServiceConfig('/Users/test'),
      }
      const plist = generateLaunchdPlist(program)
      assert.ok(plist.includes(`<string>${launchdLabel()}</string>`))
      assert.ok(plist.includes('<string>/usr/local/bin/node</string>'))
      assert.ok(plist.includes('<string>/usr/local/lib/node_modules/traceroost/standalone/cli.js</string>'))
      assert.ok(plist.includes('<key>RunAtLoad</key>'))
      assert.ok(plist.includes('<key>KeepAlive</key>'))
      assert.ok(plist.includes('<string>3000</string>'))
      assert.ok(plist.includes(serviceLogPath(program.config)))
    })
  })

  suite('generateSystemdUnit', () => {
    test('embeds ExecStart, Restart policy, env vars, and log redirection', () => {
      const program: ServiceProgram = {
        nodePath: '/usr/bin/node',
        cliPath: '/usr/lib/node_modules/traceroost/standalone/cli.js',
        config: defaultServiceConfig('/home/test'),
      }
      const unit = generateSystemdUnit(program)
      assert.ok(unit.includes('ExecStart=/usr/bin/node /usr/lib/node_modules/traceroost/standalone/cli.js'))
      assert.ok(unit.includes('Restart=on-failure'))
      assert.ok(unit.includes('Environment=UI_PORT=3000'))
      assert.ok(unit.includes(`StandardOutput=append:${serviceLogPath(program.config)}`))
      assert.ok(unit.includes('WantedBy=default.target'))
    })
  })

  suite('generateWindowsWrapperScript', () => {
    test('sets env vars and appends node output to the log file', () => {
      const program: ServiceProgram = {
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        cliPath: 'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\traceroost\\standalone\\cli.js',
        config: defaultServiceConfig('C:\\Users\\test'),
      }
      const script = generateWindowsWrapperScript(program)
      assert.ok(script.includes('set "UI_PORT=3000"'))
      assert.ok(script.includes('"C:\\Program Files\\nodejs\\node.exe"'))
      assert.ok(script.includes('>> "' + serviceLogPath(program.config) + '" 2>&1'))
    })
  })

  suite('service names', () => {
    test('exposes stable identifiers used by the platform install/uninstall commands', () => {
      assert.strictEqual(launchdLabel(), 'com.traceroost.server')
      assert.strictEqual(SYSTEMD_UNIT_NAME, 'traceroost.service')
      assert.strictEqual(WINDOWS_TASK_NAME, 'TraceRoost')
    })
  })

  suite('describeNpmFailure', () => {
    test('names a missing npm binary explicitly', () => {
      assert.strictEqual(describeNpmFailure({ code: 'ENOENT' }), 'npm was not found on your PATH')
    })

    test('reports a non-zero npm exit code', () => {
      assert.strictEqual(
        describeNpmFailure({ status: 1 }),
        'npm exited with code 1 — see its output above',
      )
      // status 0 is still a "failure" only because execFileSync threw — but report it faithfully
      assert.ok(describeNpmFailure({ status: 0 }).includes('code 0'))
    })

    test('falls back to a non-ENOENT error code', () => {
      assert.strictEqual(describeNpmFailure({ code: 'EACCES' }), 'npm could not be run (EACCES)')
    })

    test('falls back to the first line of an error message', () => {
      assert.strictEqual(
        describeNpmFailure({ message: 'network timeout\n    at ClientRequest' }),
        'network timeout',
      )
    })

    test('handles a thrown non-object', () => {
      assert.strictEqual(describeNpmFailure(undefined), 'unknown error')
      assert.strictEqual(describeNpmFailure('boom'), 'unknown error')
    })
  })

  suite('describeServiceManagerFailure', () => {
    test('names a missing service-manager binary explicitly', () => {
      assert.strictEqual(
        describeServiceManagerFailure({ code: 'ENOENT' }, 'launchctl'),
        'launchctl command was not found on your PATH',
      )
    })

    test('prefers the first non-empty line of captured stderr over an exit code', () => {
      assert.strictEqual(
        describeServiceManagerFailure({ status: 5, stderr: '\nBootstrap failed: 5: Input/output error\n' }, 'launchctl'),
        'Bootstrap failed: 5: Input/output error',
      )
    })

    test('accepts stderr as a Buffer', () => {
      assert.strictEqual(
        describeServiceManagerFailure({ stderr: Buffer.from('Load failed: 37: Operation already in progress') }, 'launchctl'),
        'Load failed: 37: Operation already in progress',
      )
    })

    test('reports a non-zero exit code when there is no stderr', () => {
      assert.strictEqual(
        describeServiceManagerFailure({ status: 1 }, 'systemctl'),
        'systemctl exited with code 1',
      )
    })

    test('falls back to a non-ENOENT error code, then the message, then a default', () => {
      assert.strictEqual(describeServiceManagerFailure({ code: 'EPERM' }, 'schtasks'), 'schtasks could not be run (EPERM)')
      assert.strictEqual(describeServiceManagerFailure({ message: 'access denied\n at x' }, 'schtasks'), 'access denied')
      assert.strictEqual(describeServiceManagerFailure(undefined), 'unknown error')
    })
  })

  suite('couldNotDownloadMessage', () => {
    test('names the reason and the fallback version when one exists', () => {
      const msg = couldNotDownloadMessage('npm exited with code 1', '0.14.0')
      assert.ok(msg.includes('npm exited with code 1'))
      assert.ok(msg.includes('v0.14.0'))
      assert.ok(msg.includes('traceroost service update'))
      assert.ok(msg.startsWith('[TraceRoost]'))
    })

    test('says there is nothing to fall back on when no version is installed', () => {
      const msg = couldNotDownloadMessage('offline', undefined)
      assert.ok(msg.includes('offline'))
      assert.ok(/nothing is installed/i.test(msg))
      assert.ok(!msg.includes('v'.concat('undefined')))
    })
  })
})
