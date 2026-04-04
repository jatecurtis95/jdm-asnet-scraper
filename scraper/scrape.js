import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

// ─── Config ──────────────────────────────────────────────────────────────────
const ASNET_USER = process.env.ASNET_USERNAME
const ASNET_PASS = process.env.ASNET_PASSWORD
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const STORAGE_BUCKET = 'vehicle-images'

// Make names in both English and Japanese for matching
const MAKES = [
  { en: 'TOYOTA', jp: 'トヨタ' },
  { en: 'NISSAN', jp: '日産' },
  { en: 'HONDA', jp: 'ホンダ' },
  { en: 'MAZDA', jp: 'マツダ' },
  { en: 'SUBARU', jp: 'スバル' },
  { en: 'MITSUBISHI', jp: '三菱' },
  { en: 'SUZUKI', jp: 'スズキ' },
  { en: 'DAIHATSU', jp: 'ダイハツ' },
  { en: 'LEXUS', jp: 'レクサス' },
  { en: 'ISUZU', jp: 'いすゞ' },
]

// Year ranges for splitting high-volume makes (Toyota, Nissan, Honda)
// Each chunk is searched separately to avoid exceeding pagination limits
const YEAR_RANGES = [
  { from: 1990, to: 2005 },
  { from: 2006, to: 2012 },
  { from: 2013, to: 2018 },
  { from: 2019, to: 2022 },
  { from: 2023, to: 2030 },
]
// Makes that need year-range splitting due to high result counts (4000+)
const HIGH_VOLUME_MAKES = ['TOYOTA', 'NISSAN', 'HONDA']

if (!ASNET_USER || !ASNET_PASS) {
  console.error('Missing ASNET_USERNAME or ASNET_PASSWORD env vars')
  process.exit(1)
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── Japanese era year conversion ────────────────────────────────────────────
function parseJapaneseYear(yearStr) {
  if (!yearStr) return null
  const s = yearStr.trim().toUpperCase()
  const match = s.match(/^([RH])(\d+)$/i)
  if (match) {
    const era = match[1].toUpperCase()
    const num = parseInt(match[2])
    if (era === 'R') return 2018 + num
    if (era === 'H') return 1988 + num
  }
  const plain = parseInt(s)
  if (plain > 1950 && plain < 2100) return plain
  return null
}

function parseMileage(text) {
  if (!text) return null
  const cleaned = text.replace(/[,\s]/g, '').toUpperCase()
  const match = cleaned.match(/([\d.]+)K/i)
  if (match) return Math.round(parseFloat(match[1]) * 1000)
  const plain = parseInt(cleaned)
  return isNaN(plain) ? null : plain
}

function parsePrice(text) {
  if (!text) return null
  const cleaned = text.replace(/[,\s¥]/g, '')
  const num = parseFloat(cleaned)
  if (isNaN(num)) return null
  return num * 1000 // K yen to yen
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Supabase Storage helpers ──────────────────���────────────────────────────
async function ensureStorageBucket() {
  const { data: buckets, error: listErr } = await supabase.storage.listBuckets()
  if (listErr) {
    log(`Cannot list buckets (expected with anon key). Assuming bucket exists.`)
    return
  }
  const exists = buckets?.some(b => b.name === STORAGE_BUCKET)
  if (!exists) {
    const { error } = await supabase.storage.createBucket(STORAGE_BUCKET, {
      public: true,
      fileSizeLimit: 10485760,
    })
    if (error && !error.message?.includes('already exists')) {
      log(`Warning: could not create bucket "${STORAGE_BUCKET}": ${error.message}`)
      log(`  Ensure the bucket exists in Supabase Dashboard > Storage`)
    } else {
      log(`Created storage bucket: ${STORAGE_BUCKET}`)
    }
  } else {
    log(`Storage bucket "${STORAGE_BUCKET}" already exists`)
  }
}

async function uploadToSupabase(buffer, stockNumber, index, subfolder) {
  try {
    if (buffer.length < 100) return null
    let mimeType = 'image/jpeg', ext = 'jpg'
    if (buffer[0] === 0x89 && buffer[1] === 0x50) { mimeType = 'image/png'; ext = 'png' }
    else if (buffer[0] === 0x47 && buffer[1] === 0x49) { mimeType = 'image/gif'; ext = 'gif' }

    const safeName = stockNumber.replace(/[^a-zA-Z0-9_-]/g, '_')
    const filePath = `${subfolder}/${safeName}/${index}.${ext}`

    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(filePath, buffer, { contentType: mimeType, upsert: true })

    if (error) {
      log(`    Upload error for ${filePath}: ${error.message}`)
      return null
    }
    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filePath)
    return urlData?.publicUrl || null
  } catch {
    return null
  }
}

// ─── Main scraper ─────────���──────────────────────��───────────────────────────
async function main() {
  log('Starting ASNET scraper v12 (Supabase image upload)...')
  log('Mode: FULL (all pages, year-range splitting for high-volume makes)')

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
    ],
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })

  // Emulate a real browser to avoid headless detection issues with image loading
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  )

  // Set longer timeout for slow ASNET pages
  page.setDefaultNavigationTimeout(60000)
  page.setDefaultTimeout(15000)

  try {
    // ─── Step 1: Login ───────────────────────────────────────────────
    log('Logging into ASNET...')
    await page.goto('https://www.asnet.jp/asnet/authentication/login', { waitUntil: 'networkidle2' })

    // Debug: log ALL input fields on the page
    const allInputs = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input, textarea')
      return Array.from(inputs).map(i => ({
        tag: i.tagName,
        type: i.type,
        name: i.name,
        id: i.id,
        placeholder: i.placeholder,
        className: i.className,
      }))
    })
    log(`Found ${allInputs.length} inputs: ${JSON.stringify(allInputs)}`)

    // Fill login form — try every approach
    const loginFilled = await page.evaluate((user, pass) => {
      const allInputs = document.querySelectorAll('input')
      let userFilled = false
      let passFilled = false

      const setValue = (input, value) => {
        input.focus()
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        input.dispatchEvent(new Event('blur', { bubbles: true }))
      }

      for (const input of allInputs) {
        const type = (input.type || '').toLowerCase()
        const name = (input.name || '').toLowerCase()
        const id = (input.id || '').toLowerCase()
        const placeholder = (input.placeholder || '').toLowerCase()

        // Password field
        if (type === 'password' && !passFilled) {
          setValue(input, pass)
          passFilled = true
          continue
        }

        // Member number / user ID field — any non-password, non-hidden, non-submit input
        if (!userFilled && type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'checkbox' && type !== 'radio') {
          setValue(input, user)
          userFilled = true
          continue
        }
      }

      return { userFilled, passFilled }
    }, ASNET_USER, ASNET_PASS)

    log(`Login form filled: user=${loginFilled.userFilled}, pass=${loginFilled.passFilled}`)

    if (!loginFilled.userFilled || !loginFilled.passFilled) {
      // Fallback: try using Puppeteer's type() on any visible input
      log('Trying Puppeteer type() fallback...')
      const inputs = await page.$$('input:not([type="hidden"]):not([type="submit"])')
      if (inputs.length >= 2) {
        await inputs[0].click({ clickCount: 3 }) // select all
        await inputs[0].type(ASNET_USER, { delay: 30 })
        await inputs[1].click({ clickCount: 3 })
        await inputs[1].type(ASNET_PASS, { delay: 30 })
        log('Typed via Puppeteer fallback')
      } else if (inputs.length === 1) {
        await inputs[0].click({ clickCount: 3 })
        await inputs[0].type(ASNET_USER, { delay: 30 })
        log(`Only found ${inputs.length} visible input`)
      }
    }

    // Click login/submit button
    const loginClicked = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, input[type="submit"], a.btn, a')
      for (const btn of btns) {
        const text = (btn.textContent || btn.value || '').trim()
        if (text.includes('ログイン') || text.includes('Login') || text.includes('login') || text.includes('Sign in')) {
          btn.click()
          return text
        }
      }
      const form = document.querySelector('form')
      if (form) { form.submit(); return 'form.submit()' }
      return null
    })
    log(`Clicked: "${loginClicked}"`)

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})

    const postLoginUrl = page.url()
    log(`Post-login URL: ${postLoginUrl}`)

    if (postLoginUrl.includes('login') || postLoginUrl.includes('authentication')) {
      log('Login FAILED — still on login page. Check credentials.')
      const errorText = await page.evaluate(() => {
        const errors = document.querySelectorAll('.error, .alert, .message, [class*="error"], [class*="alert"]')
        return Array.from(errors).map(e => e.textContent.trim()).join(' | ')
      })
      if (errorText) log(`Error messages: ${errorText}`)
      await browser.close()
      process.exit(1)
    }
    log('Login successful!')

    // Ensure Supabase Storage bucket exists
    await ensureStorageBucket()

    // Handle any post-login interstitial pages
    // Switch to English mode
    log('Switching to English...')
    const switched = await page.evaluate(() => {
      const links = document.querySelectorAll('a')
      for (const link of links) {
        if (link.textContent.trim() === 'English' || link.textContent.trim().includes('English')) {
          link.click()
          return true
        }
      }
      return false
    })
    if (switched) {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
      log(`  Switched to English: ${page.url()}`)
    } else {
      log('  Could not find English switch')
    }

    log('Handling post-login pages...')
    log(`Current URL after login: ${page.url()}`)
    const bodySnippet = await page.evaluate(() => document.body?.textContent?.replace(/\s+/g, ' ').substring(0, 300))
    log(`Page content: ${bodySnippet}`)

    // Click through any interstitial buttons/links
    await page.evaluate(() => {
      const btns = document.querySelectorAll('a, button, input[type="submit"]')
      for (const btn of btns) {
        const text = (btn.textContent || btn.value || '').trim()
        if (text.includes('進む') || text.includes('Proceed') || text.includes('OK') || text.includes('同意') || text.includes('Buy at Auction') || text.includes('Direct Search')) {
          btn.click()
          return text
        }
      }
      return null
    })
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
    log(`After interstitial: ${page.url()}`)

    // Try multiple search page URLs
    const searchUrls = [
      'https://www.asnet.jp/asnet/search/ippatsusearchlist',
      'https://www.asnet.jp/asnet/search/',
      'https://www.asnet.jp/asnet/',
    ]
    let searchPageReady = false

    for (const searchUrl of searchUrls) {
      log(`Trying search URL: ${searchUrl}`)
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {})
      log(`  Landed on: ${page.url()}`)

      const hasSelects = await page.evaluate(() => document.querySelectorAll('select').length)
      log(`  Found ${hasSelects} select dropdowns`)

      if (hasSelects > 0) {
        searchPageReady = true
        break
      }

      // Maybe we got redirected to login — check
      if (page.url().includes('login')) {
        log('  Redirected to login — session may not be valid')
        break
      }
    }

    if (!searchPageReady) {
      // Last resort: try clicking "Buy at Auction" or "Direct Search" from whatever page we're on
      log('Could not reach search page via URL. Trying to find search link on current page...')
      const clickedLink = await page.evaluate(() => {
        const links = document.querySelectorAll('a')
        for (const link of links) {
          const text = link.textContent.trim()
          if (text.includes('Buy at Auction') || text.includes('Direct Search') || text.includes('直接検索') || text.includes('ippatsusearchlist')) {
            link.click()
            return text
          }
        }
        return null
      })
      if (clickedLink) {
        log(`  Clicked: "${clickedLink}"`)
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {})
        log(`  Now at: ${page.url()}`)
      }
    }

    log(`Search page ready: ${page.url()}`)

    // Click on "Direct Search" / "Buy at AA Bid" tab
    log('Clicking Direct Search tab...')
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.evaluate(() => {
        const els = document.querySelectorAll('a')
        for (const el of els) {
          const text = el.textContent.trim()
          if (text.includes('Direct Search') || text.includes('AA Bid') || text.includes('Buy at AA Bid') || text.includes('AA入札で買う') || text.includes('直接検索')) {
            el.click()
            return text.substring(0, 50)
          }
        }
        return null
      }),
    ])
    await sleep(3000)
    log(`  Search tab loaded: ${page.url()}`)
    await page.waitForSelector('select', { timeout: 10000 }).catch(() => {})

    // ─── Step 2: Scrape each make ────────────────────────────────────
    let grandTotal = 0

    // First, identify the make dropdown by logging all select options on the search page
    if (MAKES.length > 0) {
      const makeDropdownInfo = await page.evaluate(() => {
        const selects = document.querySelectorAll('select')
        const results = []
        selects.forEach((sel, i) => {
          const opts = sel.querySelectorAll('option')
          if (opts.length > 5 && opts.length < 200) {
            const sampleOpts = Array.from(opts).slice(0, 8).map(o => `${o.value}:${o.textContent.trim()}`)
            const name = sel.name || sel.id || sel.className || `select_${i}`
            results.push({ index: i, name, optCount: opts.length, samples: sampleOpts })
          }
        })
        return results
      })
      log(`Large select dropdowns: ${JSON.stringify(makeDropdownInfo.slice(0, 5))}`)
    }

    for (let m = 0; m < MAKES.length; m++) {
      const make = MAKES[m]
      const needsSplit = HIGH_VOLUME_MAKES.includes(make.en)
      const ranges = needsSplit ? YEAR_RANGES : [null] // null = no year filter

      log(`\n[${m + 1}/${MAKES.length}] Scraping ${make.en}${needsSplit ? ` (split into ${ranges.length} year ranges)` : ''}...`)

      for (const yearRange of ranges) {
        const rangeLabel = yearRange ? `${yearRange.from}-${yearRange.to}` : 'all years'
        if (yearRange) log(`  Year range: ${rangeLabel}`)

        try {
          const makeTotal = await scrapeMakeRange(page, make, yearRange)
          grandTotal += makeTotal
          log(`  ${make.en} [${rangeLabel}] complete: ${makeTotal} vehicles synced`)
        } catch (e) {
          log(`  Error scraping ${make.en} [${rangeLabel}]: ${e.message}`)
        }
      }
    }

    log(`\n=== SCRAPE COMPLETE ===`)
    log(`Total vehicles synced: ${grandTotal}`)

  } catch (e) {
    log(`Fatal error: ${e.message}`)
    process.exit(1)
  } finally {
    await browser.close()
  }
}

// ─── Scrape a single make (optionally filtered by year range) ────────────────
async function scrapeMakeRange(page, make, yearRange) {
  // Navigate to AA Bid search page
  await page.goto('https://www.asnet.jp/asnet/search/search?initmode=201', {
    waitUntil: 'networkidle2',
    timeout: 60000,
  })
  await page.waitForSelector('select[name="MultiForm[0].MakerCode"]', { timeout: 10000 })

  // Find the option value for this make
  const optValue = await page.evaluate((makeEn, makeJp) => {
    const sel = document.querySelector('select[name="MultiForm[0].MakerCode"]')
    if (!sel) return null
    for (const opt of sel.options) {
      const text = opt.textContent.trim().toUpperCase()
      if (text.includes(makeEn) || text.includes(makeJp)) return opt.value
    }
    return null
  }, make.en, make.jp)

  if (!optValue) {
    log(`  Could not find ${make.en} in dropdown, skipping`)
    return 0
  }

  // Set make value, and optionally set year range dropdowns, then submit
  const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => 'timeout')
  await page.evaluate((val, yearRange) => {
    const sel = document.querySelector('select[name="MultiForm[0].MakerCode"]')
    sel.value = val

    // Set year range if provided — ASNET uses ModelYearFrom / ModelYearTo
    // Option values are the year number directly (e.g., "2020")
    if (yearRange) {
      // There are multiple ModelYearFrom/To selects on the page (cars, bikes, trucks tabs)
      // We need the FIRST one which is in the cars section
      const fromSel = document.querySelector('select[name="ModelYearFrom"]')
      const toSel = document.querySelector('select[name="ModelYearTo"]')

      if (fromSel) {
        // Find closest year option >= yearRange.from
        let bestOpt = null
        for (const opt of fromSel.options) {
          const v = parseInt(opt.value)
          if (v === yearRange.from) { bestOpt = opt.value; break }
          // If exact year not found, find the closest available year >= from
          if (v >= yearRange.from && v > 0 && (!bestOpt || v < parseInt(bestOpt))) bestOpt = opt.value
        }
        if (bestOpt) fromSel.value = bestOpt
      }

      if (toSel) {
        // Find closest year option <= yearRange.to
        let bestOpt = null
        for (const opt of toSel.options) {
          const v = parseInt(opt.value)
          if (v === yearRange.to) { bestOpt = opt.value; break }
          if (v <= yearRange.to && v > 0 && (!bestOpt || v > parseInt(bestOpt))) bestOpt = opt.value
        }
        if (bestOpt) toSel.value = bestOpt
      }
    }

    sel.closest('form').submit()
  }, optValue, yearRange)
  await navPromise
  log(`  Selected ${make.en} (value=${optValue})${yearRange ? ` years ${yearRange.from}-${yearRange.to}` : ''}, results: ${page.url()}`)

  // Wait for results table
  await page.waitForSelector('table tr td', { timeout: 15000 }).catch(() => {})

  // Check if we're on a results page
  const resultsCheck = await page.evaluate(() => {
    const text = document.body.textContent
    const rows = document.querySelectorAll('table tr').length
    const unitsMatch = text.match(/([\d,]+)\s*(units?\s*found|件|台)/i)
    return {
      url: window.location.href,
      rows,
      units: unitsMatch ? unitsMatch[1].replace(/,/g, '') : '0',
      hasResults: rows > 5 && (text.includes('Lot No') || text.includes('TOYOTA') || text.includes('NISSAN') || text.includes('HONDA') || text.includes('トヨタ')),
      snippet: text.replace(/\s+/g, ' ').substring(0, 300),
    }
  })
  log(`  ${resultsCheck.rows} rows, ${resultsCheck.units} units, hasResults: ${resultsCheck.hasResults}`)
  if (!resultsCheck.hasResults) {
    log(`  Page content: ${resultsCheck.snippet.substring(0, 200)}`)
  }

  // Get total count — try both English and Japanese patterns
  const totalText = await page.evaluate(() => {
    const bodyText = document.body.textContent
    let match = bodyText.match(/([\d,]+)\s*units?\s*found/i)
    if (match) return match[1].replace(/,/g, '')
    match = bodyText.match(/([\d,]+)\s*件/)
    if (match) return match[1].replace(/,/g, '')
    match = bodyText.match(/([\d,]+)\s*台/)
    if (match) return match[1].replace(/,/g, '')
    return '0'
  })
  const totalCount = parseInt(totalText)
  log(`  Found ${totalCount} ${make.en} vehicles`)

  if (totalCount === 0) return 0

  // ─── Paginate and scrape ─────────────────────────────────────
  let pageNum = 1
  let makeTotal = 0

  while (true) {
    // Scrape current page
    const vehicles = await page.evaluate(() => {
      // Map header columns
      const colMap = {}
      const allRows = document.querySelectorAll('table tr')
      for (const row of allRows) {
        const cells = row.querySelectorAll('th, td')
        const rowText = row.textContent
        if (rowText.includes('Lot No') && (rowText.includes('Make') || rowText.includes('Car Name'))) {
          cells.forEach((cell, i) => {
            const t = cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase()
            if (t.includes('picture')) colMap.picture = i
            else if (t.includes('corner') || t.includes('location')) colMap.location = i
            else if (t.includes('lot')) colMap.lotNo = i
            else if (t.includes('year')) colMap.year = i
            else if (t.includes('make') || t.includes('car name')) colMap.makeModel = i
            else if (t.includes('model') || t.includes('engine')) colMap.modelEngine = i
            else if (t.includes('inspection') || t.includes('mileage')) colMap.inspMileage = i
            else if (t.includes('exterior') || t.includes('color')) colMap.color = i
            else if (t.includes('gear')) colMap.gear = i
            else if (t.includes('score')) colMap.score = i
            else if (t.includes('start') || t.includes('wholesale') || t.includes('price')) colMap.price = i
          })
          break
        }
      }
      if (!colMap.lotNo) return []

      const vehicles = []
      for (const row of allRows) {
        const cells = row.querySelectorAll('td')
        if (cells.length < 8) continue
        const getText = (cell) => cell ? cell.textContent.replace(/\s+/g, ' ').trim() : ''
        const getLines = (cell) => {
          if (!cell) return []
          const html = cell.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<\/div>/gi, '\n')
          const temp = document.createElement('div')
          temp.innerHTML = html
          return (temp.textContent || '').split('\n').map(l => l.trim()).filter(Boolean)
        }

        const lotText = getText(cells[colMap.lotNo])
        const lotMatch = lotText.match(/(\d{2,6})/)
        if (!lotMatch) continue
        const lotNumber = lotMatch[1]

        const yearText = getText(cells[colMap.year])
        const makeLines = getLines(cells[colMap.makeModel]).filter(l => !l.includes('translated') && !l.includes('Google'))
        const modelLines = getLines(cells[colMap.modelEngine])
        const inspLines = getLines(cells[colMap.inspMileage])
        const color = getText(cells[colMap.color]) || null
        const gearLines = getLines(cells[colMap.gear])
        const scoreText = colMap.score !== undefined ? getText(cells[colMap.score]).trim() : null
        const priceText = colMap.price !== undefined ? getText(cells[colMap.price]).replace(/[^\d,]/g, '') : null
        const locLines = getLines(cells[colMap.location])

        // Image
        let imageUrl = null
        if (colMap.picture !== undefined) {
          const img = cells[colMap.picture].querySelector('img')
          if (img?.src && img.src.includes('asnet')) imageUrl = img.src
        }

        // Auction house
        let auctionHouse = null
        for (const line of locLines) {
          if (/(USS|HAA|TAA|JU |CAA|LAA|AUCNET|ZIP|BCN|ARAI)/i.test(line)) {
            auctionHouse = line
            break
          }
        }
        if (!auctionHouse) {
          for (const line of locLines) {
            if (!/AA-Bid|AS-One|Real-Bid|Negotiable|New/i.test(line) && line.length > 1) auctionHouse = line
          }
        }

        // Listing type
        let listingType = 'AA-Bid'
        const locText = getText(cells[colMap.location])
        if (locText.includes('AS-One Price')) listingType = 'AS-One Price'
        else if (locText.includes('AA-One Price')) listingType = 'AA-One Price'

        // Transmission
        let transmission = null, ac = null
        if (gearLines.length >= 1) {
          const g = gearLines[0].trim().toUpperCase()
          if (['FAT', 'AT', 'DAT', 'MT', 'CVT', 'CA'].includes(g) || /^F\d$/.test(g)) transmission = g
        }
        if (gearLines.length >= 2) {
          const a = gearLines[1].trim().toUpperCase()
          if (['AAC', 'WAC', 'AC'].includes(a)) ac = a
        }

        // Inspection / mileage
        let inspection = null, mileage = null
        for (const line of inspLines) {
          if (/[RH]\d+\/\d+/i.test(line) && !inspection) {
            const m = line.match(/[RH]\d+\/\d+/i)
            if (m) inspection = m[0]
          }
          if (/\d+K?\s*km/i.test(line) && mileage === null) {
            const cleaned = line.replace(/[,\s]/g, '').toUpperCase()
            const km = cleaned.match(/([\d.]+)K/i)
            mileage = km ? Math.round(parseFloat(km[1]) * 1000) : parseInt(cleaned) || null
          }
        }

        const houseShort = (auctionHouse || 'UNK').replace(/[^A-Za-z0-9]/g, '').substring(0, 8)
        const make = (makeLines[0] || '').charAt(0).toUpperCase() + (makeLines[0] || '').slice(1).toLowerCase()
        const modelCode = (modelLines[0] || '').trim()
        let engineCc = null
        const engMatch = (modelLines[1] || modelLines[0] || '').match(/(\d{3,5})/)
        if (engMatch) engineCc = parseInt(engMatch[1])

        vehicles.push({
          stock_number: `ASNET-${lotNumber}-${houseShort}`,
          lot_number: lotNumber,
          make,
          model: makeLines[1] || 'Unknown',
          variant: makeLines[2] || null,
          model_code: modelCode || null,
          year_raw: yearText,
          mileage_km: mileage,
          transmission,
          engine_cc: engineCc,
          exterior_color: color,
          score: (/^[SABR\d]/.test(scoreText || '') && (scoreText || '').length <= 3) ? scoreText : null,
          auction_house: auctionHouse,
          start_price_jpy_raw: priceText,
          air_conditioning: ac,
          inspection_expiry: inspection,
          listing_type: listingType,
          image_url: imageUrl,
        })
      }
      return vehicles
    })

    if (!vehicles.length) break

    // Process and upsert
    const records = vehicles
      .map(v => ({
        stock_number: v.stock_number,
        lot_number: v.lot_number,
        make: v.make,
        model: v.model,
        variant: v.variant,
        model_code: v.model_code,
        year: parseJapaneseYear(v.year_raw),
        mileage_km: v.mileage_km,
        transmission: v.transmission,
        engine_cc: v.engine_cc,
        exterior_color: v.exterior_color,
        score: v.score,
        auction_house: v.auction_house,
        start_price_jpy: parsePrice(v.start_price_jpy_raw),
        air_conditioning: v.air_conditioning,
        inspection_expiry: v.inspection_expiry,
        status: 'upcoming',
        listing_type: v.listing_type,
        source: 'asnet',
        images: v.image_url ? [v.image_url] : [],
      }))
      .filter(r => r.year && r.make)

    // Deduplicate by stock_number (same lot can appear twice in a page)
    const seen = new Set()
    const uniqueRecords = records.filter(r => {
      if (seen.has(r.stock_number)) return false
      seen.add(r.stock_number)
      return true
    })

    if (uniqueRecords.length) {
      const { error } = await supabase
        .from('auction_vehicles')
        .upsert(uniqueRecords, { onConflict: 'stock_number' })

      if (error) {
        log(`  Page ${pageNum}: upsert error: ${error.message}`)
      } else {
        makeTotal += uniqueRecords.length
        log(`  Page ${pageNum}: ${records.length} vehicles synced`)
      }
    }

    // ─── Enrich with detail images (click popup, capture AJAX images) ──
    await enrichPageWithImages(page, uniqueRecords, pageNum)

    // Go to next page
    const hasNext = await page.evaluate(() => {
      const links = document.querySelectorAll('a')
      for (const link of links) {
        if (link.textContent.trim().includes('Next')) {
          link.click()
          return true
        }
      }
      return false
    })

    if (!hasNext) break
    pageNum++
    await sleep(3000)
  }

  return makeTotal
}

// ─── Image enrichment — capture response bytes and upload to Supabase Storage ─
// Intercepts actual image HTTP responses (not just URLs) from the detail popup,
// uploads them to Supabase Storage, and stores the public URLs in the DB.
// This avoids session-protected imga.asnet2.com URLs that don't work publicly.
async function enrichPageWithImages(page, uniqueRecords, pageNum) {
  const detailLinkCount = await page.evaluate(() => document.querySelectorAll('a.showDetail').length)
  if (!detailLinkCount) return

  let enrichedCount = 0

  for (let d = 0; d < detailLinkCount && d < uniqueRecords.length; d++) {
    try {
      // Capture image response buffers as they load in the detail popup
      const capturedImages = []
      let detailHtmlReceived = false

      const responseHandler = async (response) => {
        const url = response.url()
        if (url.includes('/detail')) detailHtmlReceived = true
        if (url.includes('imga.asnet2.com/ImgGet')) {
          try {
            const buffer = await response.buffer()
            if (buffer && buffer.length > 500) {
              capturedImages.push({ buffer, isSheet: /v5=1\d{2}/.test(url) })
            }
          } catch {}
        }
      }
      page.on('response', responseHandler)

      // Click via page.evaluate (JS-level click — avoids protocolTimeout in headless)
      await page.evaluate((idx) => {
        const links = document.querySelectorAll('a.showDetail')
        if (links[idx]) links[idx].click()
      }, d)

      // Wait for detail HTML + images to load
      let waited = 0
      while (!detailHtmlReceived && waited < 10000) {
        await sleep(500)
        waited += 500
      }
      await sleep(4000) // Extra time for image responses

      page.off('response', responseHandler)

      const stockNum = uniqueRecords[d].stock_number
      const photos = capturedImages.filter(i => !i.isSheet)
      const sheets = capturedImages.filter(i => i.isSheet)

      if (capturedImages.length > 0) {
        log(`    [${d + 1}/${detailLinkCount}] ${stockNum}: captured ${photos.length} photos, ${sheets.length} sheets`)

        // Upload photos to Supabase Storage
        const photoUrls = []
        for (let i = 0; i < photos.length; i++) {
          const publicUrl = await uploadToSupabase(photos[i].buffer, stockNum, i, 'photos')
          if (publicUrl) photoUrls.push(publicUrl)
        }

        // Upload first auction sheet
        let sheetUrl = null
        if (sheets.length > 0) {
          sheetUrl = await uploadToSupabase(sheets[0].buffer, stockNum, 0, 'sheets')
        }

        log(`    [${d + 1}/${detailLinkCount}] Uploaded ${photoUrls.length} photos${sheetUrl ? ' + sheet' : ''}`)

        const updateData = {}
        if (photoUrls.length > 0) updateData.images = photoUrls
        if (sheetUrl) updateData.auction_sheet_url = sheetUrl

        if (Object.keys(updateData).length > 0) {
          await supabase.from('auction_vehicles').update(updateData).eq('stock_number', stockNum)
          enrichedCount++
        }
      }

      // Close popup — Escape key + force DOM cleanup
      await page.keyboard.press('Escape').catch(() => {})
      await sleep(300)
      await page.evaluate(() => {
        document.querySelectorAll('.ui-dialog, .ui-widget-overlay').forEach(el => el.remove())
      }).catch(() => {})
      await sleep(500)

    } catch (e) {
      log(`    [${d + 1}/${detailLinkCount}] Enrichment error: ${e.message}`)
      await page.keyboard.press('Escape').catch(() => {})
      await page.evaluate(() => {
        document.querySelectorAll('.ui-dialog, .ui-widget-overlay').forEach(el => el.remove())
      }).catch(() => {})
      await sleep(500)
    }

    if ((d + 1) % 10 === 0) log(`    Enriched ${d + 1}/${detailLinkCount} (${enrichedCount} with images)...`)
  }

  log(`  Page ${pageNum}: enriched ${enrichedCount}/${detailLinkCount} with images uploaded to Supabase Storage`)
}

main()
