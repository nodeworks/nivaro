/**
 * Which country a phone number is in, from its digits, so a text can be refused before it is sent
 * to a country the connection does not allow (toll fraud: texts to premium-rate or foreign numbers
 * are the usual way a stolen Twilio login costs money). The table covers the calling codes the
 * Hub expects; a code it does not know answers null and is refused too. +1 is one shared plan: the
 * area code tells Canada, the Caribbean and the US apart.
 */

/** Canadian area codes (NANP). */
const CANADA = new Set(
  (
    '204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 403 416 418 431 437 438 450 468 ' +
    '474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 ' +
    '819 825 867 873 879 902 905 942'
  ).split(' ')
)

/** NANP area codes that are not the US or Canada (the Caribbean, Pacific islands, territories). */
const NANP_OTHER: Record<string, string> = {
  '242': 'BS',
  '246': 'BB',
  '264': 'AI',
  '268': 'AG',
  '284': 'VG',
  '340': 'VI',
  '345': 'KY',
  '441': 'BM',
  '473': 'GD',
  '649': 'TC',
  '658': 'JM',
  '664': 'MS',
  '670': 'MP',
  '671': 'GU',
  '684': 'AS',
  '721': 'SX',
  '758': 'LC',
  '767': 'DM',
  '784': 'VC',
  '787': 'PR',
  '809': 'DO',
  '829': 'DO',
  '849': 'DO',
  '868': 'TT',
  '869': 'KN',
  '876': 'JM',
  '939': 'PR'
}

const CODES: Record<string, string> = {
  '20': 'EG',
  '27': 'ZA',
  '30': 'GR',
  '31': 'NL',
  '32': 'BE',
  '33': 'FR',
  '34': 'ES',
  '36': 'HU',
  '39': 'IT',
  '40': 'RO',
  '41': 'CH',
  '43': 'AT',
  '44': 'GB',
  '45': 'DK',
  '46': 'SE',
  '47': 'NO',
  '48': 'PL',
  '49': 'DE',
  '51': 'PE',
  '52': 'MX',
  '53': 'CU',
  '54': 'AR',
  '55': 'BR',
  '56': 'CL',
  '57': 'CO',
  '58': 'VE',
  '60': 'MY',
  '61': 'AU',
  '62': 'ID',
  '63': 'PH',
  '64': 'NZ',
  '65': 'SG',
  '66': 'TH',
  '7': 'RU',
  '81': 'JP',
  '82': 'KR',
  '84': 'VN',
  '86': 'CN',
  '90': 'TR',
  '91': 'IN',
  '92': 'PK',
  '94': 'LK',
  '98': 'IR',
  '234': 'NG',
  '254': 'KE',
  '351': 'PT',
  '352': 'LU',
  '353': 'IE',
  '354': 'IS',
  '358': 'FI',
  '370': 'LT',
  '371': 'LV',
  '372': 'EE',
  '380': 'UA',
  '420': 'CZ',
  '421': 'SK',
  '852': 'HK',
  '880': 'BD',
  '886': 'TW',
  '966': 'SA',
  '971': 'AE',
  '972': 'IL'
}

/** The ISO country of an E.164 number, or null when it cannot be told. */
export function countryOf(e164: string): string | null {
  const m = /^\+(\d{7,15})$/.exec(e164)
  if (!m) return null
  const digits = m[1]
  if (digits.startsWith('1')) {
    if (digits.length !== 11) return null
    const area = digits.slice(1, 4)
    if (CANADA.has(area)) return 'CA'
    return NANP_OTHER[area] ?? 'US'
  }
  for (const len of [3, 2, 1])
    if (Object.hasOwn(CODES, digits.slice(0, len))) return CODES[digits.slice(0, len)]
  return null
}

/** The connection's allowed SMS countries (`sms_countries`, comma list or array; default US,CA). */
export function smsCountries(config: Record<string, unknown>): string[] {
  const raw = config.sms_countries
  const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[\s,]+/)
  const out = list.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c))
  return out.length ? [...new Set(out)] : ['US', 'CA']
}

/** Null when the number may be texted; else a sentence saying why not. */
export function countryRefusal(number: string, allowed: string[]): string | null {
  const c = countryOf(number)
  if (!c)
    return `${number}: the Hub cannot tell which country this number is in, so it is not texted.`
  if (!allowed.includes(c))
    return `${number} is in ${c}, which this connection does not text (allowed: ${allowed.join(', ')}).`
  return null
}
