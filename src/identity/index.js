export {
  BLOBMAIL_CONTACT_SCHEME,
  BLOBMAIL_CONTACT_KEM,
  BLOBMAIL_CONTACT_VERSION,
  BLOBMAIL_TEXT_RECORD_KEY,
  contactFingerprint,
  createContactCode,
  parseContactCode,
} from './contact.js'

export {
  ENS_REGISTRY_ADDRESS,
  ETHEREUM_MAINNET_CHAIN_ID,
  GNS_NAME_NFT_ADDRESS,
  RecipientResolutionError,
  SEPOLIA_CHAIN_ID,
  buildTextRecordUpdate,
  createEthereumTextRecordReader,
  resolveRecipient,
} from './resolver.js'

export {
  IdentityVaultError,
  MAX_VAULT_BYTES,
  MAX_VAULT_CONTACTS,
  MAX_VAULT_MESSAGES,
  VAULT_KDF_ITERATIONS,
  VAULT_PAYLOAD_SCHEMA,
  VAULT_SCHEMA,
  createIdentityVault,
  openIdentityVault,
  openIdentityVaultSession,
  sealIdentityVault,
} from './vault.js'
