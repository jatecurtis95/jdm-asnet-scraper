import puppeteer from 'puppeteer'
import fs from 'fs'

const ASNET_USER = process.env.ASNET_USERNAME
const ASNET_PASS = process.env.ASNET_PASSWORD

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.setDefaultTimeout(60000)

  // Login
  await page.goto('https://www.asnet.jp/asnet/authentication/login', { waitUntil: 'networkidle2' })
  await page.evaluate((u, p) => {
    document.querySelector('#MemberAccount').value = u
    document.querySelector('#Password').value = p
    ;[...document.querySelectorAll('button')].find(b => b.textContent.includes('ログイン'))?.click()
  }, ASNET_USER, ASNET_PASS)
  await page.waitForNavigation({ waitUntil: 'networkidle2' })

  // English
  await page.evaluate(() => [...document.querySelectorAll('a')].find(l => l.textContent.trim() === 'English')?.click())
  await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})

  // Search Suzuki
  await page.goto('https://www.asnet.jp/asnet/search/search?initmode=201', { waitUntil: 'networkidle2' })
  await page.evaluate(() => {
    const s = document.querySelector('select[name="MultiForm[0].MakerCode"]')
    s.value = '1055'
    s.closest('form').submit()
  })
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
  console.log('On results page:', page.url())

  // Capture AJAX response
  let ajaxHtml = null
  page.on('response', async r => {
    if (r.url().includes('/detail')) ajaxHtml = await r.text().catch(() => null)
  })

  // Click first detail
  const links = await page.$$('a.showDetail')
  console.log(`${links.length} detail links`)
  if (links.length === 0) { await browser.close(); return }

  // Get images BEFORE popup
  const imgsBefore = await page.evaluate(() => document.querySelectorAll('img').length)
  console.log(`Images before click: ${imgsBefore}`)

  await links[0].click()
  console.log('Clicked detail, waiting 6 seconds...')
  await new Promise(r => setTimeout(r, 6000))

  // Save AJAX response
  if (ajaxHtml) {
    fs.writeFileSync('/tmp/detail-ajax.html', ajaxHtml)
    console.log(`AJAX response: ${ajaxHtml.length} bytes, saved to /tmp/detail-ajax.html`)

    // Find ALL URLs in AJAX response
    const urls = [...new Set([...ajaxHtml.matchAll(/(https?:\/\/[^"'\s<>]+)/gi)].map(m => m[1]))]
      .filter(u => u.includes('asnet') && (u.includes('.jpg') || u.includes('.png') || u.includes('ImgGet')))
    console.log(`Image URLs in AJAX: ${urls.length}`)
    urls.forEach(u => console.log(`  ${u}`))
  } else {
    console.log('No AJAX response captured')
  }

  // Get images AFTER popup
  const imgsAfter = await page.evaluate(() => {
    const all = [...document.querySelectorAll('img')]
    return {
      total: all.length,
      srcs: all.map(i => i.src).filter(s => s && s.includes('asnet') && !s.includes('noimage') && !s.includes('icon') && !s.includes('logo') && !s.includes('ad/'))
    }
  })
  console.log(`\nImages after click: ${imgsAfter.total} total, ${imgsAfter.srcs.length} ASNET images`)
  imgsAfter.srcs.forEach(u => console.log(`  ${u}`))

  await browser.close()
  console.log('\nDone!')
}

main().catch(e => { console.error(e.message); process.exit(1) })
