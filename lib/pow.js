import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Companion module shipped beside this file. */
const WASM_FILE = 'sha3_wasm_bg.wasm'

let wasmPromise = null

/**
 * Load the official DeepSeek PoW module once and reuse the instance.
 *
 * The module is plain wasm-bindgen output: no imports are needed, and it exports
 * its own linear memory plus the allocator and stack-pointer helpers.
 */
function loadWasm() {
  if (wasmPromise === null) {
    wasmPromise = (async () => {
      const here = dirname(fileURLToPath(import.meta.url))
      const bytes = await readFile(join(here, WASM_FILE))
      const { instance } = await WebAssembly.instantiate(bytes, {})
      return instance
    })().catch((error) => {
      // A failed load must not be cached, or every later call would repeat it.
      wasmPromise = null
      throw error
    })
  }
  return wasmPromise
}

/**
 * Solve one DeepSeek `DeepSeekHashV1` proof-of-work challenge.
 *
 * A naive SHA3 loop over the challenge text does NOT reproduce this: the shipped
 * module hashes its own byte layout, and the reference implementations that skip
 * the wasm note their fallback may disagree with it. So the official module runs
 * the search and only the answer is read back — an int32 status at the return
 * slot (`0` means no solution) and a float64 answer at `retptr + 8`.
 *
 * @param {{ algorithm: string, challenge: string, salt: string, expire_at: number, difficulty: number, signature: string, target_path?: string }} challenge
 * @returns {Promise<number>} the nonce to report as `answer`.
 */
export async function solvePow(challenge) {
  const { challenge: value, salt, expire_at: expireAt, difficulty } = challenge
  if (typeof value !== 'string' || value === '' || typeof salt !== 'string') {
    throw new Error('proof-of-work challenge is missing challenge or salt')
  }
  if (!Number.isFinite(Number(difficulty))) {
    throw new Error(`proof-of-work difficulty is not a number: ${difficulty}`)
  }

  const instance = await loadWasm()
  const { memory } = instance.exports
  const write = (text) => {
    const encoded = Buffer.from(text, 'utf8')
    const pointer = instance.exports.__wbindgen_export_0(encoded.length, 1)
    // `memory.buffer` is replaced whenever the module grows, so re-read it here.
    new Uint8Array(memory.buffer).set(encoded, pointer)
    return { pointer, length: encoded.length }
  }

  const retptr = instance.exports.__wbindgen_add_to_stack_pointer(-16)
  try {
    const challengeInfo = write(value)
    const prefixInfo = write(`${salt}_${expireAt}_`)
    instance.exports.wasm_solve(
      retptr,
      challengeInfo.pointer,
      challengeInfo.length,
      prefixInfo.pointer,
      prefixInfo.length,
      Number(difficulty),
    )

    const status = new Int32Array(memory.buffer)[retptr / 4]
    if (status === 0) throw new Error('proof-of-work module found no solution for this challenge')
    const answer = new Float64Array(memory.buffer)[(retptr + 8) / 8]
    return Math.floor(answer)
  } finally {
    instance.exports.__wbindgen_add_to_stack_pointer(16)
  }
}

/**
 * Build the base64 `X-DS-PoW-Response` header value the completion endpoint expects.
 *
 * @param {object} challenge the payload from `create_pow_challenge`.
 * @param {number} answer the nonce returned by {@link solvePow}.
 * @param {string} targetPath the request path the challenge was created for.
 * @returns {string} base64 of the JSON answer envelope.
 */
export function encodePowResponse(challenge, answer, targetPath) {
  const envelope = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath,
  }
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
}
