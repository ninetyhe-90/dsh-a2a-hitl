DSH A2A HITL - local validation project

Purpose
A reusable Cordis plugin that delegates requests to configured external agents and
relays human input through DSH's existing userQuestions capability. It does not
replace the DSH agent loop, register an auto-confirm tool, or embed CRM logic.
No existing DSH profile, gateway, container, or online service is modified.

Quick start
  npm ci --include=dev
  npm run check
  npm run demo
Open the LOCAL_DEMO_URL printed by the last command. The port is assigned locally.
Start a request, choose Cancel, or enter a change request and answer the new question.
Confirm only increases an in-memory simulation counter. Stop with Ctrl+C.

Validation boundaries
The local demo uses real Cordis, ToolsService, and UserQuestionService packages.
The Agent lifecycle and remote A2A endpoint are simulated. No model is requested.
This validates the plugin tool and trusted human-answer relay, not a complete DSH
Web/ACP deployment. The supplied browser is a local test UI for the native seam.
The existing ontology Java ACP client does not bridge native questions; installing
this plugin alone would not make that client display confirmations.
Do not deploy this project or install it into an existing production/test profile.

Supported wire protocol
Legacy JSON-RPC tasks/sendSubscribe over SSE, matching external-call.md.
Card discovery selects the first non-empty supportedInterfaces JSONRPC URL, then
Card.url. The RPC origin must be the Card origin or an explicit allowedRpcOrigins
entry. A configured rpcUrl can pin a known endpoint instead of discovery.
Human input uses input-required plus artifacts[].metadata.kind=hitl_required.
Answers preserve the original caller sessionId and hitl_id. selected contains exact
labels; non-empty custom_input takes priority and clears selected. No contextId or
taskId is added to this legacy request: the remote service must bind sessionId and
hitl_id to its pending original task. Returned task ids are checked throughout.
Modern SendMessage/TASK_STATE_INPUT_REQUIRED and client_tool are not supported.
Grouped questions extensions are rejected rather than flattened into ambiguous
answers. The supported base protocol allows one question with single/multi-select.
Remote errors are never retried automatically. A network failure can leave an
unknown remote outcome; do not retry a write without checking the remote task.

Configuration for an isolated future local DSH profile
The package includes a dsh.bundle patch and examples/profile.patch.yml.
The default patch grants access to no agents. Every allowed agent must be configured
by an administrator; models select an id, never a URL or authentication material.
A new isolated DSH Web/SDK host must have tools, userQuestions, and a trusted UI
answerer. The original calling Agent must be live and must not be a subagent.
For packaging only: npm pack. This produces a tarball; it does not publish or install.
An isolated user's DSH profile can later install that tarball with dsh plugin add,
but this project does not run that command or change any existing profiles.

Agent settings
  id: unique identifier
  cardUrl: absolute HTTPS Card URL
  rpcUrl: optional administrator-pinned absolute RPC URL
  description: optional routing hint
  allowedRpcOrigins: optional exact origins for cross-origin Card endpoints
  headersEnv: header-name to environment-variable-name mapping
  allowPrivateNetwork: false by default; explicit local/internal opt-in
  allowInsecureHttp: false by default; explicit loopback HTTP opt-in

Authentication values are read only from environment variables. For example,
headersEnv.Authorization: EXAMPLE_A2A_AUTHORIZATION reads the complete header value
from that variable, including Bearer when needed. Header mappings can also supply
X-A2A-Caller, X-A2A-Secret, X-A2A-Rtx without project-specific code.
Do not use a fixed shared user credential in a multi-user host; authenticate each
principal in a trusted adapter. This sample has one local user and no credentials.
URL credentials, fragments and query parameters are forbidden. Redirects are
forbidden. DNS is checked and pinned to the actual socket. Private/reserved and
9/11/21/30 address blocks are denied unless explicitly allowed; link-local metadata
addresses and translated/tunnel IPv6 remain forbidden.

Lifecycle
The host owns DSH conversation history and tool records. The client retains only
bounded, process-local owner-to-remote-session handles, not its own transcript.
After errors, restart, expiry or plugin disposal, handles become invalid. Human
cancel/skip/timeout never fabricates confirmation. Human-selected Cancel is relayed
as the exact remote label. Duplicate nodes cannot be reused in the active task.
No cancellation is invented or sent to an unsupported remote CancelTask method.

Known limits
Only trusted UI answers may satisfy the human provider; remote or model-generated
answers must not be wired to that provider. Native generic UI can still show a
free-text control when the remote disallows it; the plugin rejects that input.
Remote deltas are exposed by the standalone client onDelta callback. The plugin
returns a complete tool result while DSH remains in charge of its own streaming.
Native tool-result/turn history remains under DSH ownership.

Dependencies
Exact build/test dependencies are locked in package-lock.json. Peer dependencies
reuse host services. Compatibility has been source-checked for dsh-v0.2.1-rc.5 and
validated using the listed installed DSH package version; refer to local check output
for the actual version. No monorepo paths are required in the published package.
Published on GitHub at https://github.com/ninetyhe-90/dsh-a2a-hitl with a
prebuilt tarball attached to release v0.1.1. The package has not been published
to npm; install the release tarball or the repository directly with dsh plugin add.

License
The source is public, but commercial use is not permitted. This project is
released under the PolyForm Noncommercial License 1.0.0; see LICENSE.
The @deepseek-ai/* packages remain under their own licenses and still require
access to the matching registry.
