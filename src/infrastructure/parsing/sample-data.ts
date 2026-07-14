/**
 * INFRASTRUCTURE — Built-in sample dataset
 * Generates a realistic sales CSV as a File so the "Load sample" affordance
 * exercises the exact same import pipeline as a user-provided file.
 */

const REGIONS = ['West', 'East', 'North', 'South', 'Central']
const COUNTRIES = ['United States', 'Canada', 'Mexico']
const SEGMENTS = ['Enterprise', 'SMB', 'Consumer']
const CATEGORIES = ['Hardware', 'Software', 'Services', 'Accessories']
const PRODUCTS: Record<string, string[]> = {
  Hardware: ['Aurora Laptop', 'Nimbus Monitor', 'Vertex Desktop'],
  Software: ['Studio Pro', 'Analytics Suite', 'Cloud Sync'],
  Services: ['Onboarding', 'Support Plan', 'Training'],
  Accessories: ['Mesh Keyboard', 'Glide Mouse', 'Dock Station'],
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function makeSampleCsv(rows = 800): string {
  const header = [
    'OrderID',
    'OrderDate',
    'Region',
    'Country',
    'Segment',
    'Category',
    'Product',
    'Quantity',
    'UnitPrice',
    'Discount',
    'Revenue',
    'Returned',
  ].join(',')

  const lines: string[] = [header]
  for (let i = 0; i < rows; i++) {
    const category = pick(CATEGORIES)
    const product = pick(PRODUCTS[category])
    const year = 2024 + Math.floor(Math.random() * 3)
    const month = 1 + Math.floor(Math.random() * 12)
    const day = 1 + Math.floor(Math.random() * 28)
    const qty = 1 + Math.floor(Math.random() * 20)
    const unitPrice = Math.round((20 + Math.random() * 480) * 100) / 100
    const discount = Math.round(Math.random() * 0.3 * 100) / 100
    const revenue = Math.round(qty * unitPrice * (1 - discount) * 100) / 100
    const returned = Math.random() < 0.08 ? 'Yes' : 'No'

    lines.push(
      [
        1000 + i,
        `${year}-${pad(month)}-${pad(day)}`,
        pick(REGIONS),
        pick(COUNTRIES),
        pick(SEGMENTS),
        category,
        product,
        qty,
        unitPrice,
        discount,
        revenue,
        returned,
      ].join(','),
    )
  }
  return lines.join('\n')
}

export function makeSampleFile(rows = 800): File {
  const csv = makeSampleCsv(rows)
  return new File([csv], 'Sample Sales.csv', { type: 'text/csv' })
}
