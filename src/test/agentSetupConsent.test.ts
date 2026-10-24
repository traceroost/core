import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { agentSetupWaitingLine, leftAloneMessage, parseSkipConfirmation, parseYesNo, readAgentSetupAnswer, writeAgentSetupAnswer } from '../agentSetupConsent'
import { AGENT_SETUP_QUESTION, AGENT_SETUP_SKIP_QUESTION } from '../agentSetupText'
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

  test('only y or yes is a yes', () => {
    for (const yes of ['y', 'Y', 'yes', ' YES ']) assert.strictEqual(parseYesNo(yes), 'yes', yes)
    for (const no of ['', 'n', 'no', 'yep', 'sure']) assert.strictEqual(parseYesNo(no), 'no', no)
  })

  test('confirming a no: Enter or yes keeps it, only n or no takes it back', () => {
    for (const keep of ['', 'y', 'Y', 'yes', 'whatever']) assert.strictEqual(parseSkipConfirmation(keep), 'no', keep)
    for (const back of ['n', 'N', 'no', ' NO ']) assert.strictEqual(parseSkipConfirmation(back), 'yes', back)
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

  test('the terminal re-prompt names whichever question is waiting', () => {
    assert.ok(agentSetupWaitingLine('setup').includes(AGENT_SETUP_QUESTION))
    assert.ok(!agentSetupWaitingLine('setup').includes(AGENT_SETUP_SKIP_QUESTION))
    assert.ok(agentSetupWaitingLine('skip').includes(AGENT_SETUP_SKIP_QUESTION))
    assert.ok(!agentSetupWaitingLine('skip').includes(AGENT_SETUP_QUESTION))
  })
})
