function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function add32(left: number, right: number): number {
  return (left + right) | 0;
}

function rotateLeft(value: number, amount: number): number {
  return (value << amount) | (value >>> (32 - amount));
}

function md5Cycle(state: number[], block: number[]): void {
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let index = 0; index < 64; index++) {
    let value: number;
    let word: number;
    let shift: number;
    if (index < 16) {
      value = (b & c) | (~b & d);
      word = index;
      shift = shifts[index % 4]!;
    } else if (index < 32) {
      value = (d & b) | (~d & c);
      word = (5 * index + 1) % 16;
      shift = shifts[4 + (index % 4)]!;
    } else if (index < 48) {
      value = b ^ c ^ d;
      word = (3 * index + 5) % 16;
      shift = shifts[8 + (index % 4)]!;
    } else {
      value = c ^ (b | ~d);
      word = (7 * index) % 16;
      shift = shifts[12 + (index % 4)]!;
    }
    const constant = Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) | 0;
    const next = d;
    d = c;
    c = b;
    b = add32(b, rotateLeft(add32(add32(a, value), add32(constant, block[word]!)), shift));
    a = next;
  }
  state[0] = add32(state[0]!, a);
  state[1] = add32(state[1]!, b);
  state[2] = add32(state[2]!, c);
  state[3] = add32(state[3]!, d);
}

export function md5(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = BigInt(bytes.length) * 8n;
  const lengthView = new DataView(padded.buffer);
  lengthView.setUint32(paddedLength - 8, Number(bitLength & 0xffffffffn), true);
  lengthView.setUint32(paddedLength - 4, Number((bitLength >> 32n) & 0xffffffffn), true);

  const state = [0x67452301, -0x10325477, -0x67452302, 0x10325476];
  for (let offset = 0; offset < paddedLength; offset += 64) {
    const block = Array.from({ length: 16 }, (_, index) => lengthView.getInt32(offset + index * 4, true));
    md5Cycle(state, block);
  }
  return state.map((word) => [0, 8, 16, 24]
    .map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, "0"))
    .join("")).join("");
}

export function createOpenApiSign(params: Record<string, string>, secret: string): string {
  if (!secret) throw new Error("OpenAPI signing secret is required");
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${phpUrlEncode(params[key]!)}`)
    .join("&");
  return md5(query + secret);
}

export function createSignedOpenApiParams(
  params: Record<string, string | number | boolean | null | undefined>,
  secret: string,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) normalized[key] = String(value);
  }
  return { ...normalized, sign: createOpenApiSign(normalized, secret) };
}
