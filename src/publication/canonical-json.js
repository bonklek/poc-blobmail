const encoder = new TextEncoder()

function normalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical JSON numbers must be safe integers')
    return value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object') {
    const output = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError(`canonical JSON cannot encode undefined at ${key}`)
      output[key] = normalize(value[key])
    }
    return output
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`)
}

export function canonicalJson(value) {
  return `${JSON.stringify(normalize(value))}\n`
}

export function canonicalJsonBytes(value) {
  return encoder.encode(canonicalJson(value))
}
