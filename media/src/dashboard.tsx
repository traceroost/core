import { render } from 'preact'
import { App } from './App'
import { setVscode } from './state'

import './styles/base.css'
import './styles/toolbar.css'
import './styles/tabs.css'
import './styles/components.css'
import './styles/waterfall.css'
import './styles/summaries.css'
import './styles/heatmap.css'
import './styles/export.css'
import './styles/help.css'
import './styles/tooltip.css'
import './styles/insights.css'
import './styles/graph.css'
// Shared with traceroost-cloud — see packages/styles/README.md. Consumed here by relative
// import (same repo); traceroost-cloud installs it as a published dependency instead.
import '../../packages/styles/src/pills.css'

const vscode = window.acquireVsCodeApi()
setVscode(vscode)

render(<App />, document.getElementById('app')!)
