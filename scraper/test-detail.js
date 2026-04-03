import puppeteer from 'puppeteer'

const ASNET_USER = process.env.ASNET_USERNAME
const ASNET_PASS = process.env.ASNET_PASSWORD

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(60000)

  // Login
  await page.goto('https://www.asnet.jp/asnet/authentication/login', { waitUntil: 'networkidle2' })
  await page.evaluate((user, pass) => {
    document.querySelector('#MemberAccount').value = user
    document.querySelector('#MemberAccount').dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('#Password').value = pass
    document.querySelector('#Password').dispatchEvent(new Event('input', { bubbles: true }))
  }, ASNET_USER, ASNET_PASS)
  await page.evaluate(() => {
    for (const btn of document.querySelectorAll('button')) {
      if (btn.textContent.includes('ログイン')) { btn.click(); return }
    }
  })
  await page.waitForNavigation({ waitUntil: 'networkidle2' })

  // English
  await page.evaluate(() => {
    for (const l of document.querySelectorAll('a')) { if (l.textContent.trim() === 'English') { l.click(); return } }
  })
  await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})

  // Search Suzuki via form.submit()
  await page.goto('https://www.asnet.jp/asnet/search/search?initmode=201', { waitUntil: 'networkidle2' })
  await page.evaluate(() => {
    const sel = document.querySelector('select[name="MultiForm[0].MakerCode"]')
    sel.value = '1055'
    sel.closest('form').submit()
  })
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
  console.log('Results:', page.url())

  const count = await page.evaluate(() => document.querySelectorAll('a.showDetail').length)
  console.log(`${count} showDetail links`)

  // Capture ALL responses from clicking first detail
  console.log('\n=== CLICKING DETAIL - capturing ALL responses ===')

  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('analytics') || url.includes('matomo') || url.includes('.css') || url.includes('.woff')) return
    const ct = response.headers()['content-type'] || ''
    if (!ct.includes('html') && !ct.includes('json') && !ct.includes('text')) return

    const body = await response.text().catch(() => '')
    // Log ALL non-trivial responses
    if (body.length > 100) {
      const imgCount = (body.match(/\.jpg|\.jpeg|\.png/gi) || []).length
      console.log(`[${response.status()}] ${url.substring(0, 130)} | ${body.length}b | img_refs:${imgCount}`)

      // If it has image references, extract them
      if (imgCount > 2) {
        const imgs = [...new Set([...body.matchAll(/(https?:\/\/[^"'\s>]+\.(?:jpg|jpeg|png))/gi)].map(m => m[1]))]
          .filter(u => (u.includes('asnet') || u.includes('ASDATA') || u.includes('imgs')) && !u.includes('noimage') && !u.includes('icon') && !u.includes('logo') && !u.includes('ad/'))
        if (imgs.length > 0) {
          console.log(`  VEHICLE IMAGES (${imgs.length}):`)
          imgs.forEach(u => console.log(`    ${u}`))
        }
      }
    }
  })

  const links = await page.$$('a.showDetail')
  if (links.length > 0) {
    await links[0].click()
    console.log('Clicked, waiting 8 seconds for all AJAX...')
    await new Promise(r => setTimeout(r, 8000))

    // Also check DOM for images that loaded
    const domImages = await page.evaluate(() => {
      return [...new Set([...document.querySelectorAll('img')].map(i => i.src))]
        .filter(u => (u.includes('asnet') || u.includes('ASDATA') || u.includes('imgs')) && !u.includes('noimage') && !u.includes('icon') && !u.includes('logo') && !u.includes('ad/'))
    })
    console.log(`\nDOM images after popup (${domImages.length}):`)
    domImages.forEach(u => console.log(`  ${u}`))
  }

  await browser.close()
  console.log('\nDone!')
}

main().catch(e => { console.error(e.message); process.exit(1) })
