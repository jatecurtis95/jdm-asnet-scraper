import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

// ─── Config ──────────────────────────────────────────────────────────────────
const ASNET_USER = process.env.ASNET_USERNAME
const ASNET_PASS = process.env.ASNET_PASSWORD
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const TEST_MODE = process.argv.includes('--test')
const MAX_PAGES_PER_MAKE = TEST_MODE ? 1 : 200

const MAKES = [
  'TOYOTA', 'NISSAN', 'HONDA', 'MAZDA', 'SUBARU',
  'MITSUBISHI', 'SUZUKI', 'DAIHATSU', 'LEXUS', 'ISUZU',
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
  log('Starting ASNET scraper...')
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
    await page.goto('https://www.asnet.jp/asnet/login', { waitUntil: 'networkidle2' })

    // Fill login form
    await page.type('input[name="userId"], input[name="user_id"], input[type="text"]', ASNET_USER, { delay: 50 })
    await page.type('input[name="password"], input[type="password"]', ASNET_PASS, { delay: 50 })

    // Click login button
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click('input[type="submit"], button[type="submit"], .login_btn, #login_btn'),
    ])

    // Check if login succeeded
    const pageUrl = page.url()
    if (pageUrl.includes('login')) {
      log('Login failed — check credentials')
      await browser.close()
      process.exit(1)
    }
    log('Login successful!')

    // ─── Step 2: Scrape each make ────────────────────────────────────
    let grandTotal = 0

    for (let m = 0; m < MAKES.length; m++) {
      const make = MAKES[m]
      log(`\n[${m + 1}/${MAKES.length}] Scraping ${make}...`)

      try {
        // Navigate to Direct Search
        await page.goto('https://www.asnet.jp/asnet/search/ippatsusearchlist', {
          waitUntil: 'networkidle2',
        })
        await page.waitForSelector('select', { timeout: 10000 })

        // Select the make from the dropdown
        const selected = await page.evaluate((makeName) => {
          const selects = document.querySelectorAll('select')
          for (const sel of selects) {
            const options = sel.querySelectorAll('option')
            for (const opt of options) {
              if (opt.textContent.toUpperCase().includes(makeName)) {
                sel.value = opt.value
                sel.dispatchEvent(new Event('change', { bubbles: true }))
                return true
              }
            }
          }
          return false
        }, make)

        if (!selected) {
          log(`  Could not find ${make} in dropdown, skipping`)
          continue
        }

        // Click search button
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
          page.evaluate(() => {
            const btns = document.querySelectorAll('button, input[type="submit"], a')
            for (const btn of btns) {
              if ((btn.textContent || btn.value || '').includes('Search') || (btn.textContent || '').includes('検索')) {
                btn.click()
                return true
              }
            }
            const form = document.querySelector('form')
            if (form) { form.submit(); return true }
            return false
          }),
        ])

        await page.waitForSelector('table', { timeout: 10000 }).catch(() => {})

        // Get total count
        const totalText = await page.evaluate(() => {
          const match = document.body.textContent.match(/([\d,]+)\s*units?\s*found/i)
          return match ? match[1].replace(/,/g, '') : '0'
        })
        const totalCount = parseInt(totalText)
        log(`  Found ${totalCount} ${make} vehicles`)

        if (totalCount === 0) continue

        // ─── Paginate and scrape ─────────────────────────────────────
        let pageNum = 1
        let makeTotal = 0

        while (pageNum <= MAX_PAGES_PER_MAKE) {
          // Scrape current page
          const vehicles = await page.evaluate((makeName) => {
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
          }, make)

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
        log(`  ${make} complete: ${makeTotal} vehicles synced`)

      } catch (e) {
        log(`  Error scraping ${make}: ${e.message}`)
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
