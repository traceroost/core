import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AGENT_SETUP_TERMINAL_PROMPT, agentSetupWaitingLine, leftAloneMessage, parseAgentSetupInput, readAgentSetupAnswer, writeAgentSetupAnswer } from '../agentSetupConsent'
import { AGENT_SETUP_DECLINED, AGENT_SETUP_DONT, AGENT_SETUP_EXPLANATION, AGENT_SETUP_NOT_NOW, AGENT_SETUP_QUESTION } from '../agentSetupText'
import { readServiceConfig, writeServiceConfig, defaultServiceConfig } from '../serviceConfig'

suite('agentSetupConsent', () => {
  let home: string
  setup(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-consent-')) })
  teardown(() => { fs.rmSync(home, { recursive: true, force: true }) })

  test('unanswered until the user answers, then remembered', () => {
    assert.strictEqual(readAgentSetupAnswer(home), undefined)
    writeAgentSetupAnswer('no', home)
    assert.strictEqual(readAgentSetupAnswer(home), 'no')
    writeAgentSetupAnswer('yes', home)
    assert.strictEqual(readAgentSetupAnswer(home), 'yes')
  })

  test('recording an answer keeps the rest of config.json, the access token above all', () => {
    writeServiceConfig({ ...defaultServiceConfig(home), authToken: 'tok', uiPort: 3100 }, home)
    writeAgentSetupAnswer('yes', home)
    const config = readServiceConfig(home)
    assert.strictEqual(config.authToken, 'tok')
    assert.strictEqual(config.uiPort, 3100)
  })

  test('a hand-edited value that is neither yes nor no reads as unanswered', () => {
    writeServiceConfig({ ...defaultServiceConfig(home), agentSetup: 'maybe' as 'yes' }, home)
    assert.strictEqual(readAgentSetupAnswer(home), undefined)
  })

  test('terminal: y is a yes, "never" is don\'t set up, Enter or anything else is not now', () => {
    for (const yes of ['y', 'Y', 'yes', ' YES ']) assert.strictEqual(parseAgentSetupInput(yes), 'yes', yes)
    for (const no of ['never', 'NEVER', ' never ']) assert.strictEqual(parseAgentSetupInput(no), 'no', no)
    for (const notNow of ['', '   ', 'n', 'no', 'yep', 'later']) assert.strictEqual(parseAgentSetupInput(notNow), undefined, notNow)
    assert.match(AGENT_SETUP_TERMINAL_PROMPT, /y = yes, Enter = not now, "never" = don't set up/)
  })

  test('"Not now" records nothing, so the question comes back; the stored values stay yes/no', () => {
    assert.strictEqual(parseAgentSetupInput(''), undefined)
    assert.strictEqual(readAgentSetupAnswer(home), undefined)
    assert.match(AGENT_SETUP_EXPLANATION, new RegExp(`${AGENT_SETUP_NOT_NOW} asks again next time; ${AGENT_SETUP_DONT} stops asking`))
    assert.match(AGENT_SETUP_DECLINED, /only sees what their log files record/)
  })

  test('the dashboard shows the same words as VS Code and the terminal', () => {
    const root = path.resolve(__dirname, '../../..')
    const body = (file: string) => {
      const text = fs.readFileSync(path.join(root, file), 'utf-8')
      return text.slice(text.indexOf('/** The question'))
    }
    assert.strictEqual(body('media/src/agentSetupText.ts'), body('src/agentSetupText.ts'))
  })

  test('Set Up Agents: an agent left alone is named, not reported as already set up', () => {
    assert.strictEqual(leftAloneMessage([], 4318), undefined)
    const one = leftAloneMessage(['Claude Code'], 4318) ?? ''
    assert.match(one, /left Claude Code alone — it already sends OTel to another collector/)
    assert.match(one, /its traces won't reach port 4318/)
    assert.doesNotMatch(one, /Nothing needed changing/)
    const several = leftAloneMessage(['Copilot', 'Claude Code', 'Codex'], 4318) ?? ''
    assert.match(several, /left Copilot, Claude Code and Codex alone — they already send OTel/)
    assert.match(several, /their traces/)
  })

  test('the terminal re-prompt repeats the question and its three answers', () => {
    const line = agentSetupWaitingLine()
    assert.ok(line.includes(AGENT_SETUP_QUESTION))
    assert.match(line, /y = yes, Enter = not now, "never" = don't set up/)
  })
})
