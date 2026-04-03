import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

// ─── Config ──────────────────────────────────────────────────────────────────
const ASNET_USER = process.env.ASNET_USERNAME
const ASNET_PASS = process.env.ASNET_PASSWORD
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const TEST_MODE = process.argv.includes('--test')
const MAX_PAGES_PER_MAKE = TEST_MODE ? 1 : 200

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

// ─── Main scraper ────────────────────────────────────────────────────────────
async function main() {
  log('Starting ASNET scraper v3...')
  log(`Mode: ${TEST_MODE ? 'TEST (1 page per make)' : 'FULL'}`)

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })

  // Set longer timeout for slow ASNET pages
  page.setDefaultNavigationTimeout(30000)
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
        // Might only have password visible, user might be separate
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

    // Handle any post-login interstitial pages
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

    // Click on "Direct Search" tab
    log('Looking for Direct Search tab...')
    const tabClicked = await page.evaluate(() => {
      const els = document.querySelectorAll('a, li, div, span, button, label')
      for (const el of els) {
        const text = el.textContent.trim()
        if (text === 'Direct Search' || text === '直接検索' || text.includes('ダイレクトサーチ')) {
          el.click()
          return text.substring(0, 50)
        }
      }
      // Try "AA入札で買う" as fallback
      for (const el of els) {
        const text = el.textContent.trim()
        if (text === 'AA入札で買う') {
          el.click()
          return text
        }
      }
      return null
    })
    log(`  Clicked tab: "${tabClicked}"`)
    await new Promise(r => setTimeout(r, 3000))
    log(`  URL after tab: ${page.url()}`)

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
      log(`\n[${m + 1}/${MAKES.length}] Scraping ${make.en}...`)

      try {
        // Navigate to search page (use the URL we know works after login)
        await page.goto('https://www.asnet.jp/asnet/search/search', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        })

        await page.waitForSelector('select', { timeout: 15000 }).catch(() => {})

        // Select the make from the dropdown — try both English and Japanese names
        const selected = await page.evaluate((makeEn, makeJp) => {
          const selects = document.querySelectorAll('select')
          for (const sel of selects) {
            const options = sel.querySelectorAll('option')
            for (const opt of options) {
              const text = opt.textContent.trim().toUpperCase()
              const val = (opt.value || '').toUpperCase()
              if (text.includes(makeEn) || text.includes(makeJp) || val.includes(makeEn)) {
                sel.value = opt.value
                sel.dispatchEvent(new Event('change', { bubbles: true }))
                return { found: true, selectName: sel.name || sel.id, optValue: opt.value, optText: opt.textContent.trim() }
              }
            }
          }
          return { found: false }
        }, make.en, make.jp)

        if (!selected.found) {
          log(`  Could not find ${make.en} / ${make.jp} in any dropdown, skipping`)
          continue
        }
        log(`  Selected: ${selected.optText} (value=${selected.optValue}) in dropdown "${selected.selectName}"`)


        // Submit search — find and submit the form containing MakerCode
        log(`  Submitting search form...`)
        const searchClicked = await page.evaluate(() => {
          // First priority: find the form containing our MakerCode select and submit it
          const makerSelect = document.querySelector('select[name="MultiForm[0].MakerCode"]')
          if (makerSelect) {
            const form = makerSelect.closest('form')
            if (form) {
              // Look for a submit button within this form
              const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
              if (submitBtn) {
                submitBtn.click()
                return `form button: "${(submitBtn.textContent || submitBtn.value || '').trim()}"`
              }
              // No submit button found, try form.submit()
              form.submit()
              return 'form.submit() on MakerCode form'
            }
          }

          // Fallback: find any search button on the page
          const allBtns = document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn')
          for (const btn of allBtns) {
            const text = (btn.textContent || btn.value || '').trim()
            if (text.includes('検索') || text.includes('Search')) {
              btn.click()
              return `button: "${text}"`
            }
          }
          return null
        })
        log(`  Search submitted: ${searchClicked}`)

        // Wait for results — ASNET is a SPA, so wait for AJAX/DOM changes, not page navigation
        // Wait for navigation OR timeout (SPA won't navigate)
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {}),
          new Promise(r => setTimeout(r, 8000)),
        ])
        log(`  Results URL: ${page.url()}`)

        // Wait for results table to appear in DOM
        await page.waitForSelector('table tr td', { timeout: 10000 }).catch(() => {})

        // Log what's on the page now
        const resultsInfo = await page.evaluate(() => ({
          url: window.location.href,
          bodySnippet: document.body.textContent.replace(/\s+/g, ' ').substring(0, 300),
          tableRows: document.querySelectorAll('table tr').length,
          hasLotNo: document.body.textContent.includes('Lot No') || document.body.textContent.includes('Lot No.'),
        }))
        log(`  Results: ${resultsInfo.tableRows} table rows, hasLotNo: ${resultsInfo.hasLotNo}`)
        log(`  Content: ${resultsInfo.bodySnippet.substring(0, 200)}`)

        // Get total count — try both English and Japanese patterns
        const totalText = await page.evaluate(() => {
          const bodyText = document.body.textContent
          // English: "4,001 units found"
          let match = bodyText.match(/([\d,]+)\s*units?\s*found/i)
          if (match) return match[1].replace(/,/g, '')
          // Japanese: "4,001 件" or "4,001台"
          match = bodyText.match(/([\d,]+)\s*件/)
          if (match) return match[1].replace(/,/g, '')
          match = bodyText.match(/([\d,]+)\s*台/)
          if (match) return match[1].replace(/,/g, '')
          return '0'
        })
        const totalCount = parseInt(totalText)
        log(`  Found ${totalCount} ${make.en} vehicles`)

        if (totalCount === 0) continue

        // ─── Paginate and scrape ─────────────────────────────────────
        let pageNum = 1
        let makeTotal = 0

        while (pageNum <= MAX_PAGES_PER_MAKE) {
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

          if (records.length) {
            const { error } = await supabase
              .from('auction_vehicles')
              .upsert(records, { onConflict: 'stock_number' })

            if (error) {
              log(`  Page ${pageNum}: upsert error: ${error.message}`)
            } else {
              makeTotal += records.length
              log(`  Page ${pageNum}: ${records.length} vehicles synced`)
            }
          }

          // ─── Enrich with detail images ─────────────────────────────
          const detailLinks = await page.$$('a.showDetail')
          if (detailLinks.length > 0) {
            log(`  Page ${pageNum}: enriching ${detailLinks.length} vehicles with detail images...`)

            for (let d = 0; d < detailLinks.length && d < vehicles.length; d++) {
              try {
                // Re-query the links (DOM may have changed)
                const links = await page.$$('a.showDetail')
                if (d >= links.length) break

                await links[d].click()
                await page.waitForTimeout(2000)

                // Scrape all images from the popup
                const enrichment = await page.evaluate((stockNum) => {
                  const imgs = document.querySelectorAll('img')
                  const images = []
                  let sheetUrl = null

                  imgs.forEach(img => {
                    const src = img.src || ''
                    if (!src || src.length < 20) return
                    if (src.includes('spacer') || src.includes('icon') || src.includes('btn_')) return
                    if (src.includes('arrow') || src.includes('logo') || src.includes('bg_')) return
                    if (src.includes('google') || src.includes('gstatic')) return
                    if (src.includes('asnet') || src.includes('ASDATA') || src.includes('imgm.')) {
                      if (!images.includes(src)) images.push(src)
                    }
                  })

                  // Heuristic: largest image is likely the auction sheet
                  if (images.length > 2) {
                    imgs.forEach(img => {
                      if (img.src && images.includes(img.src)) {
                        const rect = img.getBoundingClientRect()
                        if (rect.width > 300 && rect.height > 200) sheetUrl = img.src
                      }
                    })
                  }

                  const vehiclePhotos = sheetUrl ? images.filter(s => s !== sheetUrl) : images
                  return { stock_number: stockNum, images: vehiclePhotos, auction_sheet_url: sheetUrl }
                }, vehicles[d].stock_number)

                if (enrichment.images.length > 0 || enrichment.auction_sheet_url) {
                  const updateData = { images: enrichment.images }
                  if (enrichment.auction_sheet_url) updateData.auction_sheet_url = enrichment.auction_sheet_url

                  await supabase
                    .from('auction_vehicles')
                    .update(updateData)
                    .eq('stock_number', enrichment.stock_number)
                }

                // Close popup
                await page.evaluate(() => {
                  const closeBtn = document.querySelector('.ui-dialog-titlebar-close, .close, [title="Close"], button.close, a.close, span.close')
                  if (closeBtn) closeBtn.click()
                  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
                })
                await page.waitForTimeout(500)

              } catch (e) {
                // Non-critical, continue
              }
            }
          }

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
          await page.waitForTimeout(3000)
        }

        grandTotal += makeTotal
        log(`  ${make.en} complete: ${makeTotal} vehicles synced`)

      } catch (e) {
        log(`  Error scraping ${make.en}: ${e.message}`)
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

main()
