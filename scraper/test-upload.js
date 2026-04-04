/**
 * Quick test: login to ASNET, open a detail popup, capture image response bytes, upload to Supabase.
 */
import puppeteer from 'puppeteer'
import { createClient } from '@supabase/supabase-js'

const ASNET_USER = process.env.ASNET_USERNAME
const ASNET_PASS = process.env.ASNET_PASSWORD
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const STORAGE_BUCKET = 'vehicle-images'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`) }

async function main() {
  log('=== Image Upload Test (response interception) ===')

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(30000)
  page.setDefaultTimeout(15000)

  // Login
  log('Logging in...')
  await page.goto('https://www.asnet.jp/asnet/authentication/login', { waitUntil: 'networkidle2' })
  await page.evaluate((user, pass) => {
    const inputs = document.querySelectorAll('input')
    for (const input of inputs) {
      if (input.type === 'password') { input.value = pass; input.dispatchEvent(new Event('input', { bubbles: true })) }
      else if (input.type === 'text' && input.name === 'MemberAccount') { input.value = user; input.dispatchEvent(new Event('input', { bubbles: true })) }
    }
  }, ASNET_USER, ASNET_PASS)
  await page.evaluate(() => { document.querySelector('form')?.submit() })
  await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
  log(`Post-login: ${page.url()}`)

  // Search for Nissan
  log('Navigating to search...')
  await page.goto('https://www.asnet.jp/asnet/search/search?initmode=201', { waitUntil: 'networkidle2' })
  await page.waitForSelector('select[name="MultiForm[0].MakerCode"]', { timeout: 10000 })
  const navP = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {})
  await page.evaluate(() => {
    const sel = document.querySelector('select[name="MultiForm[0].MakerCode"]')
    sel.value = '1015'
    sel.closest('form').submit()
  })
  await navP
  log(`Results: ${page.url()}`)

  // Set up response interception for images
  const capturedImages = []
  let detailHtmlReceived = false
  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('/detail/detail')) {
      detailHtmlReceived = true
      log(`  Detail HTML received`)
    }
    if (url.includes('imga.asnet2.com/ImgGet')) {
      try {
        const buffer = await response.buffer()
        const isSheet = /v5=1\d{2}/.test(url)
        log(`  Captured image: ${buffer.length} bytes, sheet=${isSheet}, url=${url.substring(0, 80)}...`)
        if (buffer.length > 500) capturedImages.push({ buffer, isSheet })
      } catch (e) {
        log(`  Failed to capture image buffer: ${e.message}`)
      }
    }
  })

  // Click first detail link
  const detailLinks = await page.$$('a.showDetail')
  log(`Found ${detailLinks.length} detail links, clicking first...`)
  if (!detailLinks.length) { await browser.close(); return }

  await detailLinks[0].click()

  // Wait for detail + images
  let waited = 0
  while (!detailHtmlReceived && waited < 10000) { await new Promise(r => setTimeout(r, 500)); waited += 500 }
  log('Waiting for images to load...')
  await new Promise(r => setTimeout(r, 5000))

  const photos = capturedImages.filter(i => !i.isSheet)
  const sheets = capturedImages.filter(i => i.isSheet)
  log(`\nCaptured: ${photos.length} photos, ${sheets.length} sheets`)

  // Upload first photo
  if (photos.length > 0) {
    const buffer = photos[0].buffer
    let mimeType = 'image/jpeg', ext = 'jpg'
    if (buffer[0] === 0x89 && buffer[1] === 0x50) { mimeType = 'image/png'; ext = 'png' }

    const filePath = `photos/TEST-001/0.${ext}`
    log(`\nUploading photo: ${filePath} (${buffer.length} bytes, ${mimeType})`)
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(filePath, buffer, { contentType: mimeType, upsert: true })
    if (error) {
      log(`Upload error: ${error.message}`)
    } else {
      const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filePath)
      log(`SUCCESS! Public URL: ${data.publicUrl}`)
    }
  }

  // Upload first sheet
  if (sheets.length > 0) {
    const buffer = sheets[0].buffer
    let mimeType = 'image/jpeg', ext = 'jpg'
    if (buffer[0] === 0x89 && buffer[1] === 0x50) { mimeType = 'image/png'; ext = 'png' }

    const filePath = `sheets/TEST-001/0.${ext}`
    log(`\nUploading sheet: ${filePath} (${buffer.length} bytes, ${mimeType})`)
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(filePath, buffer, { contentType: mimeType, upsert: true })
    if (error) {
      log(`Upload error: ${error.message}`)
    } else {
      const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filePath)
      log(`SUCCESS! Public URL: ${data.publicUrl}`)
    }
  }

  await browser.close()
  log('\n=== Done ===')
}

main().catch(e => { console.error(e); process.exit(1) })
