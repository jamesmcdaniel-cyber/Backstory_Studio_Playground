/**
 * Demo-mode alias book: deterministic real→fictional substitution.
 *
 * Pure by the same rule as src/lib/catalogue/sanitize.ts — no DB, no env, no
 * clock — so the snapshot engine and the tests exercise identical behaviour.
 * Determinism is the load-bearing property: sha256(orgId : kind : value)
 * indexes fixed dictionaries, so the same real company is the same fictional
 * company on every screen, in every run, and across re-entry into a demo
 * workspace. Different orgs hash differently, so two workspaces that share a
 * customer never share an alias.
 *
 * Aliases are FICTIONAL, not merely scrambled: a marketing capture must show
 * names that read as real companies and people while matching nothing real.
 * Generated values sit in reserved spaces where one exists (TEST-NET IPs,
 * 555 phone exchange, 900- SSN prefix, the 4242 test PAN shape).
 */

import { createHash } from 'node:crypto'

export interface AliasBook {
  company(name: string): { name: string; domain: string }
  person(input: { name?: string | null; email?: string | null; companyName?: string | null }): {
    name: string
    email: string | null
    title: string
  }
  logoDataUrl(seedName: string): string
  phone(real: string): string
  streetAddress(real: string): string
  ip(real: string): string
  nationalId(real: string): string
  cardNumber(real: string): string
  /** Normalised real value → alias, for the free-text sweep. */
  entries(): ReadonlyMap<string, string>
}

const COMPANIES: readonly { name: string; domain: string }[] = [
  'Northwind Traders', 'Windy City Storage', 'Cascade Analytics', 'Harbor Lane Logistics',
  'Bluefield Robotics', 'Copper Kettle Foods', 'Silverpine Software', 'Atlas Verde Energy',
  'Juniper Grid Systems', 'Foxglove Financial', 'Marble Arch Media', 'Quartz Harbor Health',
  'Lanternfish Labs', 'Redwood Meridian', 'Saltgrass Shipping', 'Violet Summit Group',
  'Ironbark Industrial', 'Clearwater Compute', 'Golden Prairie Goods', 'Nimbus Point Retail',
  'Stonebridge Textiles', 'Aster & Vale', 'Peregrine Payments', 'Larkspur Learning',
  'Driftwood Digital', 'Cobalt Row Studios', 'Maple Union Bank', 'Halcyon Freight',
  'Ridgeline Renewables', 'Tidepool Technologies', 'Amber Gate Security', 'Whistlewood Works',
  'Brightmoor Biotech', 'Canary Wharf Coffee', 'Delta Fern Farms', 'Everhart Electric',
  'Fable Street Press', 'Glasswing Travel', 'Hollowell Hardware', 'Indigo Basin Mining',
  'Kestrel Cloud', 'Longleaf Insurance', 'Moonstone Metrics', 'Nettleton Foods',
  'Opaline Optics', 'Pinebox Furniture', 'Quill & Compass', 'Rookery Real Estate',
  'Sundial Systems', 'Thistledown Apparel', 'Umberline Paints', 'Vantage Fen Consulting',
  'Wrenfield Water', 'Yarrow Analytics', 'Zephyr Cove Marine', 'Bramblewood Brands',
  'Crescent Quay Capital', 'Dovetail Dynamics', 'Elmspring Education', 'Fernway Fitness',
  'Gullwing Aviation', 'Heathrow Lane Hotels', 'Islet Point Imports', 'Jackdaw Journals',
  'Kilnworth Ceramics', 'Lodestone Legal', 'Mistral Manufacturing', 'Nightjar Networks',
  'Oakhaven Outdoors', 'Pembroke Print', 'Quarry Bend Concrete', 'Rushlight Records',
  'Saffron Peak Spices', 'Tallow & Twine', 'Underwood Utilities', 'Vellum Ventures',
  'Wintergreen Wellness', 'Applecross Automotive', 'Birchmere Boats', 'Cinder Row Games',
].map((name) => ({
  name,
  domain: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.com`,
}))

const FIRST_NAMES = [
  'Dana', 'Marcus', 'Priya', 'Elena', 'Theo', 'Nadia', 'Owen', 'Camille', 'Jonas', 'Ruth',
  'Felix', 'Amara', 'Victor', 'Ingrid', 'Hassan', 'Beatriz', 'Cole', 'Mireille', 'Stefan', 'Wren',
  'Alexis', 'Bruno', 'Celeste', 'Dmitri', 'Esme', 'Farid', 'Greta', 'Hugo', 'Iris', 'Jasper',
  'Katya', 'Leon', 'Maren', 'Nils', 'Odette', 'Pascal', 'Quinn', 'Rosalind', 'Sven', 'Talia',
  'Ursula', 'Vera', 'Wallace', 'Ximena', 'York', 'Zelda', 'Ansel', 'Bianca', 'Caspian', 'Delphine',
  'Emrys', 'Flora', 'Gideon', 'Hazel', 'Ivo', 'Juniper', 'Kai', 'Lorna', 'Milo', 'Noor',
]
const LAST_NAMES = [
  'Whitfield', 'Okafor', 'Lindqvist', 'Marchetti', 'Byrne', 'Castellanos', 'Duval', 'Eriksen',
  'Fontaine', 'Grimaldi', 'Halloran', 'Ibarra', 'Jansen', 'Kowalczyk', 'Larkin', 'Moreau',
  'Nakamura', 'Ostrowski', 'Pemberton', 'Quimby', 'Rasmussen', 'Sylvestre', 'Thackeray', 'Ueda',
  'Vasquez', 'Winterbourne', 'Xanthos', 'Yoshida', 'Zielinski', 'Ashcroft', 'Bellweather',
  'Cormier', 'Dunmore', 'Ellery', 'Farrow', 'Galloway', 'Hollister', 'Iverson', 'Juneau',
  'Kirkland', 'Lockhart', 'Merriweather', 'Northgate', 'Oakes', 'Prescott', 'Quennell',
  'Ridgeway', 'Stanhope', 'Thorne', 'Underhill', 'Vance', 'Wexford', 'Yardley', 'Zeller',
  'Ainsley', 'Bramble', 'Colfax', 'Deverell', 'Ellsworth', 'Fairbanks',
]
const TITLES = [
  'VP of Sales', 'Account Executive', 'Head of Revenue Operations', 'Chief Revenue Officer',
  'Director of Procurement', 'Solutions Engineer', 'Customer Success Manager', 'Head of IT',
  'Chief Financial Officer', 'Director of Marketing', 'Operations Manager', 'General Counsel',
  'VP of Engineering', 'Head of Partnerships', 'Regional Sales Director', 'Product Manager',
  'Chief Operating Officer', 'Director of Analytics', 'Procurement Lead', 'IT Administrator',
  'Head of Growth', 'Enterprise Architect', 'Facilities Director', 'Controller',
  'VP of Customer Experience', 'Business Development Manager', 'Head of Security', 'Data Lead',
  'Supply Chain Manager', 'Chief of Staff',
]
const STREETS = [
  'Alder Row', 'Birchwood Avenue', 'Cinder Lane', 'Dorset Street', 'Elmhurst Boulevard',
  'Foxtail Drive', 'Garland Court', 'Hawthorne Way', 'Ivy Bend Road', 'Juniper Street',
  'Kingfisher Lane', 'Lantern Hill Road', 'Mulberry Avenue', 'Nettle Creek Drive',
  'Osprey Court', 'Primrose Way', 'Quarry Street', 'Rosewood Boulevard', 'Sablewood Drive',
  'Thistle Lane',
]

/** Hash the (org, kind, normalised value) triple into a stable uint stream. */
function digest(orgId: string, kind: string, value: string): Buffer {
  return createHash('sha256').update(`${orgId}:${kind}:${value}`).digest()
}
const pick = <T>(list: readonly T[], hash: Buffer, byte: number): T =>
  list[hash.readUInt16BE(byte) % list.length]

const normalise = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()

export function createAliasBook(realOrgId: string): AliasBook {
  const map = new Map<string, string>()
  const remember = (real: string, alias: string) => {
    map.set(normalise(real), alias)
    return alias
  }

  const company = (name: string) => {
    const hash = digest(realOrgId, 'company', normalise(name))
    const alias = pick(COMPANIES, hash, 0)
    remember(name, alias.name)
    return alias
  }

  return {
    company,
    person({ name, email, companyName }) {
      const seed = normalise(name ?? email ?? 'unknown person')
      const hash = digest(realOrgId, 'person', seed)
      const first = pick(FIRST_NAMES, hash, 0)
      const last = pick(LAST_NAMES, hash, 2)
      const aliasName = `${first} ${last}`
      const title = pick(TITLES, hash, 4)
      if (name) remember(name, aliasName)
      let aliasEmail: string | null = null
      if (email) {
        // On the company alias domain when we know the company; otherwise a
        // domain derived from the person seed, so colleagues at an unknown
        // employer still share nothing with the real address.
        const domain = companyName ? company(companyName).domain : pick(COMPANIES, hash, 6).domain
        aliasEmail = `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`
        remember(email, aliasEmail)
      }
      return { name: aliasName, email: aliasEmail, title }
    },
    logoDataUrl(seedName) {
      const hash = digest(realOrgId, 'logo', normalise(seedName))
      const hue = hash.readUInt16BE(0) % 360
      const initials = seedName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0]?.toUpperCase() ?? '')
        .join('')
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="hsl(${hue} 55% 45%)"/><text x="64" y="64" dy=".35em" text-anchor="middle" font-family="sans-serif" font-size="52" font-weight="600" fill="#fff">${initials}</text></svg>`
      return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
    },
    phone(real) {
      const hash = digest(realOrgId, 'phone', normalise(real))
      const line = String(hash.readUInt16BE(0) % 10_000).padStart(4, '0')
      return remember(real, `(555) 01${String(hash[2] % 100).padStart(2, '0')}-${line}`)
    },
    streetAddress(real) {
      const hash = digest(realOrgId, 'address', normalise(real))
      const number = (hash.readUInt16BE(0) % 980) + 10
      return remember(real, `${number} ${pick(STREETS, hash, 2)}`)
    },
    ip(real) {
      const hash = digest(realOrgId, 'ip', normalise(real))
      return remember(real, `203.0.113.${hash[0] % 255}`)
    },
    nationalId(real) {
      const hash = digest(realOrgId, 'nid', normalise(real))
      const mid = String(hash[0] % 100).padStart(2, '0')
      const tail = String(hash.readUInt16BE(1) % 10_000).padStart(4, '0')
      return remember(real, `900-${mid}-${tail}`)
    },
    cardNumber(real) {
      const hash = digest(realOrgId, 'card', normalise(real))
      const mid = String(hash.readUInt16BE(0) % 100).padStart(2, '0')
      return remember(real, `4242 42${mid} XXXX 4242`)
    },
    entries() {
      return map
    },
  }
}
