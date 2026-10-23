import {
  ETHEREUM_MAINNET_CHAIN_ID,
  buildTextRecordUpdate,
  createEthereumTextRecordReader,
  createIdentityVault,
  openIdentityVaultSession,
} from '../identity/index.js'
import { refreshMailbox } from '../mailbox/index.js'
import { boundedFetchJson, createBrowserRpc, createNetworkProfile } from '../network/index.js'
import { createBatcherClient, sendBlobMailMessage } from '../sending/index.js'
import { createBoundedSidecarCache } from '../sidecars/cache.js'

const VAULT_KEY = 'blobmail.mvp.v1.encrypted-vault'
const SETTINGS_KEY = 'blobmail.mvp.v1.settings'
const DEFAULTS = Object.freeze({
  batcher: 'http://127.0.0.1:8787',
  mainnetRpc: 'https://ethereum-rpc.publicnode.com',
  sepoliaRpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  sepoliaBeacon: 'https://lodestar-sepolia.chainsafe.io',
})

function markup(hasVault) {
  return `
    <main class="mvp-shell">
      <header><div><p class="eyebrow">SEPOLIA MVP · ERC-8179 DISCOVERY</p><h1>BlobMail</h1></div><span class="status" data-status>Locked</span></header>
      <section class="card auth" data-auth>
        <h2>${hasVault ? 'Unlock your mailbox' : 'Create your mailbox'}</h2>
        <p>${hasVault ? 'Your identity and messages are encrypted in this browser.' : 'Choose a passphrase of at least 12 UTF-8 bytes. There is no recovery service.'}</p>
        <label>Passphrase<input type="password" data-passphrase autocomplete="current-password" minlength="12"></label>
        ${hasVault ? '' : '<label>Confirm passphrase<input type="password" data-confirm autocomplete="new-password" minlength="12"></label>'}
        <button class="primary" data-action="auth">${hasVault ? 'Unlock' : 'Create encrypted mailbox'}</button>
        <p class="error" data-auth-error></p>
        <details><summary>Restore an encrypted backup</summary>
          <label>Encrypted vault JSON<textarea data-restore rows="5" placeholder="Paste a BlobMail encrypted vault backup"></textarea></label>
          <button data-action="restore">Validate and restore</button>
        </details>
      </section>

      <div data-workspace hidden>
        <section class="card identity">
          <div><p class="eyebrow">YOUR RECEIVING IDENTITY</p><h2>Contact code</h2></div>
          <code data-contact></code>
          <div class="actions"><button data-action="copy-contact">Copy contact</button><button data-action="copy-backup">Copy encrypted backup</button><button data-action="lock">Lock</button><button data-action="delete-vault">Delete local vault</button></div>
          <p class="hint">Initialize the mailbox before sharing this code. Publish it as the <code>com.blobmail</code> text record on a .eth or .gwei name.</p>
        </section>

        <div class="grid">
          <section class="card compose">
            <p class="eyebrow">SEND</p><h2>Compose</h2>
            <label>Recipient<input data-recipient placeholder="alice.eth, alice.gwei, or blobmail:v0:…"></label>
            <label>Message<textarea data-message rows="6" maxlength="480" placeholder="Plain text, up to 480 bytes"></textarea></label>
            <div class="actions"><span data-byte-count>0 / 480 bytes</span><button class="primary" data-action="send">Encrypt and send</button></div>
            <p class="result" data-send-result></p>
          </section>

          <section class="card inbox">
            <div class="actions heading"><div><p class="eyebrow">RECEIVE</p><h2>Inbox</h2></div><button class="primary" data-action="check">Check chain</button></div>
            <p class="result" data-check-result></p><div class="messages" data-inbox></div>
          </section>
        </div>

        <section class="card sent"><p class="eyebrow">LOCAL ENCRYPTED HISTORY</p><h2>Sent</h2><div class="messages" data-outbox></div></section>

        <details class="card settings"><summary>Connection settings</summary>
          <label>Reference batcher<input data-setting="batcher"></label>
          <label>Mainnet RPC (.eth and .gwei)<input data-setting="mainnetRpc"></label>
          <label>Sepolia execution RPC<input data-setting="sepoliaRpc"></label>
          <label>Sepolia beacon API<input data-setting="sepoliaBeacon"></label>
          <button data-action="save-settings">Save settings</button><p class="result" data-settings-result></p>
        </details>

        <details class="card names"><summary>Prepare a .eth or .gwei text-record transaction</summary>
          <p>This produces unsigned transaction fields for your wallet. BlobMail never requests your name-owner key.</p>
          <label>Name<input data-name placeholder="yourname.eth or yourname.gwei"></label>
          <button data-action="prepare-name">Prepare transaction</button><pre data-name-result></pre>
        </details>
      </div>
    </main>`
}

function safeSettings(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(SETTINGS_KEY) ?? '{}')
    return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, typeof parsed[key] === 'string' ? parsed[key] : fallback]))
  } catch { return { ...DEFAULTS } }
}

function messageNode(message, outgoing = false) {
  const article = document.createElement('article')
  const body = document.createElement('p')
  body.textContent = message.body
  const meta = document.createElement('small')
  meta.textContent = outgoing
    ? `${message.recipient} · ${message.status} · ${message.submittedAt}`
    : `Block ${message.blockNumber} · ${message.receivedAt}`
  article.append(body, meta)
  return article
}

function errorText(error) {
  return `${error?.code ? `${error.code}: ` : ''}${error instanceof Error ? error.message : 'Operation failed'}`
}

export function startMvpClient({ root = document.querySelector('#app'), storage = globalThis.localStorage } = {}) {
  if (!root || !storage) throw new Error('BlobMail requires a DOM root and browser storage')
  root.innerHTML = markup(Boolean(storage.getItem(VAULT_KEY)))
  let session = null
  let busy = false
  let settings = safeSettings(storage)
  let kzgPromise
  const refs = {
    auth: root.querySelector('[data-auth]'), workspace: root.querySelector('[data-workspace]'),
    passphrase: root.querySelector('[data-passphrase]'), confirm: root.querySelector('[data-confirm]'),
    authError: root.querySelector('[data-auth-error]'), status: root.querySelector('[data-status]'),
    contact: root.querySelector('[data-contact]'), recipient: root.querySelector('[data-recipient]'),
    message: root.querySelector('[data-message]'), byteCount: root.querySelector('[data-byte-count]'),
    sendResult: root.querySelector('[data-send-result]'), checkResult: root.querySelector('[data-check-result]'),
    inbox: root.querySelector('[data-inbox]'), outbox: root.querySelector('[data-outbox]'),
    settingsResult: root.querySelector('[data-settings-result]'), name: root.querySelector('[data-name]'),
    nameResult: root.querySelector('[data-name-result]'),
    restore: root.querySelector('[data-restore]'),
  }
  for (const input of root.querySelectorAll('[data-setting]')) input.value = settings[input.dataset.setting]

  function render() {
    const vault = session?.getVault()
    refs.auth.hidden = Boolean(vault)
    refs.workspace.hidden = !vault
    refs.status.textContent = vault ? 'Unlocked locally' : 'Locked'
    if (!vault) return
    refs.contact.textContent = vault.contactCode
    refs.inbox.replaceChildren(...(vault.mailbox.inbox.length
      ? vault.mailbox.inbox.map((item) => messageNode(item))
      : [Object.assign(document.createElement('p'), { textContent: 'No verified messages yet.' })]))
    refs.outbox.replaceChildren(...(vault.mailbox.outbox.length
      ? vault.mailbox.outbox.map((item) => messageNode(item, true))
      : [Object.assign(document.createElement('p'), { textContent: 'No sent messages yet.' })]))
  }

  async function saveMailbox(mailbox) {
    const envelope = await session.save({ mailbox })
    storage.setItem(VAULT_KEY, envelope)
    render()
  }

  function mainnetReader() {
    const rpc = createBrowserRpc(settings.mainnetRpc)
    return createEthereumTextRecordReader({ request: rpc.request, expectedChainId: ETHEREUM_MAINNET_CHAIN_ID })
  }

  function sepoliaNetwork() {
    const execution = new URL(settings.sepoliaRpc)
    const beacon = new URL(settings.sepoliaBeacon)
    const profile = createNetworkProfile({
      BLOBMAIL_NETWORK_MODE: 'readonly',
      BLOBMAIL_NETWORK: 'sepolia',
      BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL: execution.origin,
      BLOBMAIL_SEPOLIA_BEACON_RPC_URL: beacon.origin,
      BLOBMAIL_SEPOLIA_ALLOWED_HOSTS: `${execution.hostname},${beacon.hostname}`,
    })
    return { profile, executionRpc: createBrowserRpc(execution.origin), requestJson: boundedFetchJson }
  }

  root.addEventListener('input', (event) => {
    if (event.target === refs.message) refs.byteCount.textContent = `${new TextEncoder().encode(refs.message.value).byteLength} / 480 bytes`
  })

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]')
    if (!button || busy) return
    const action = button.dataset.action
    busy = true
    try {
      if (action === 'auth') {
        refs.authError.textContent = ''
        const existing = storage.getItem(VAULT_KEY)
        if (existing) session = await openIdentityVaultSession(existing, refs.passphrase.value)
        else {
          if (refs.passphrase.value !== refs.confirm.value) throw new Error('Passphrases do not match')
          const created = await createIdentityVault(refs.passphrase.value)
          storage.setItem(VAULT_KEY, created.envelope)
          session = await openIdentityVaultSession(created.envelope, refs.passphrase.value)
        }
        refs.passphrase.value = ''
        if (refs.confirm) refs.confirm.value = ''
        render()
      } else if (action === 'restore') {
        const restored = refs.restore.value.trim()
        const restoredSession = await openIdentityVaultSession(restored, refs.passphrase.value)
        storage.setItem(VAULT_KEY, restored)
        session?.lock()
        session = restoredSession
        refs.passphrase.value = ''
        refs.restore.value = ''
        render()
      } else if (action === 'lock') {
        session.lock(); session = null; location.reload()
      } else if (action === 'copy-contact') {
        await navigator.clipboard.writeText(session.getVault().contactCode)
      } else if (action === 'copy-backup') {
        await navigator.clipboard.writeText(storage.getItem(VAULT_KEY))
      } else if (action === 'delete-vault') {
        if (globalThis.confirm('Permanently delete this browser\'s encrypted BlobMail vault? Export a backup first if needed.')) {
          session.lock(); session = null; storage.removeItem(VAULT_KEY); location.reload()
        }
      } else if (action === 'save-settings') {
        settings = Object.fromEntries([...root.querySelectorAll('[data-setting]')].map((input) => [input.dataset.setting, input.value.trim()]))
        createBatcherClient({ endpoint: settings.batcher })
        createBrowserRpc(settings.mainnetRpc); sepoliaNetwork()
        storage.setItem(SETTINGS_KEY, JSON.stringify(settings))
        refs.settingsResult.textContent = 'Settings saved.'
      } else if (action === 'send') {
        refs.sendResult.textContent = 'Resolving and encrypting…'
        const reader = mainnetReader()
        const result = await sendBlobMailMessage({
          recipient: refs.recipient.value.trim(), text: refs.message.value,
          readEnsText: reader.readEnsText, readGweiText: reader.readGweiText,
          batcher: createBatcherClient({ endpoint: settings.batcher }),
        })
        const vault = session.getVault()
        const outbox = [{
          entryId: result.entryId, body: refs.message.value, recipient: refs.recipient.value.trim(),
          submittedAt: new Date().toISOString(), status: 'included', batchId: result.batchId,
          transactionHash: result.transactionHash,
        }, ...vault.mailbox.outbox.filter(({ entryId }) => entryId !== result.entryId)].slice(0, 128)
        await saveMailbox({ ...vault.mailbox, outbox })
        refs.message.value = ''; refs.byteCount.textContent = '0 / 480 bytes'
        refs.sendResult.textContent = `Included: ${result.transactionHash}`
      } else if (action === 'check') {
        refs.checkResult.textContent = 'Discovering declarations and verifying sidecars…'
        const vault = session.getVault()
        const network = sepoliaNetwork()
        if (vault.mailbox.cursor.nextBlock === 0) {
          const headHex = await network.executionRpc.requestRpc('eth_blockNumber')
          const nextBlock = Math.max(0, Number(BigInt(headHex)) - 1)
          await saveMailbox({ ...vault.mailbox, cursor: { nextBlock, anchor: null } })
          refs.checkResult.textContent = `Mailbox initialized at Sepolia block ${nextBlock}. Share your contact code now.`
        } else {
          // Do not cache a failed load, or every later check would fail until reload.
          kzgPromise ??= import('kzg-wasm').then(({ loadKZG }) => loadKZG()).catch((error) => {
            kzgPromise = undefined
            throw error
          })
          const received = await refreshMailbox({
            profile: network.profile, requestRpc: network.executionRpc.requestRpc,
            requestJson: network.requestJson, kzg: await kzgPromise,
            identity: vault.identity, fromBlock: vault.mailbox.cursor.nextBlock,
            anchor: vault.mailbox.cursor.anchor,
            existingEntryIds: vault.mailbox.inbox.map(({ entryId }) => entryId),
            cache: createBoundedSidecarCache(),
          })
          const inbox = [...received.messages, ...vault.mailbox.inbox].slice(0, 128)
          await saveMailbox({ ...vault.mailbox, inbox, cursor: received.cursor })
          refs.checkResult.textContent = `Verified ${received.batches.length} batch(es); ${received.messages.length} new message(s).`
        }
      } else if (action === 'prepare-name') {
        const update = await buildTextRecordUpdate(refs.name.value.trim(), session.getVault().contactCode, mainnetReader())
        refs.nameResult.textContent = JSON.stringify({ chainId: String(update.chainId), to: update.to, data: update.data, value: '0x0' }, null, 2)
      }
    } catch (error) {
      const target = ['auth', 'restore'].includes(action) ? refs.authError : action === 'send' ? refs.sendResult
        : action === 'check' ? refs.checkResult : action === 'prepare-name' ? refs.nameResult : refs.settingsResult
      target.textContent = errorText(error)
    } finally { busy = false }
  })

  render()
  return Object.freeze({ getSession: () => session })
}
