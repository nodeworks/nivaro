/* ============================================================
   NIVARO MARKETING — app.js
   Smooth scroll (Lenis) + GSAP animations + scroll reveals
============================================================ */

;(() => {
  /* ── Lenis smooth scroll ── */
  function initLenis() {
    if (typeof Lenis === 'undefined') return
    const lenis = new Lenis({ duration: 0.8, easing: (t) => 1 - (1 - t) ** 4 })
    function raf(time) {
      lenis.raf(time)
      requestAnimationFrame(raf)
    }
    requestAnimationFrame(raf)
    // Anchor links
    document.querySelectorAll('a[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const target = document.querySelector(a.getAttribute('href'))
        if (!target) return
        e.preventDefault()
        lenis.scrollTo(target, { offset: -72 })
      })
    })
  }

  /* ── Nav scroll class ── */
  function initNav() {
    const nav = document.getElementById('nav')
    if (!nav) return
    const THRESHOLD = 40
    let ticking = false
    function update() {
      nav.classList.toggle('is-scrolled', window.scrollY > THRESHOLD)
      ticking = false
    }
    window.addEventListener(
      'scroll',
      () => {
        if (!ticking) {
          requestAnimationFrame(update)
          ticking = true
        }
      },
      { passive: true }
    )
    update()
  }

  /* ── Scroll reveals with IntersectionObserver ── */
  function initReveals() {
    // Respect reduced motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view')
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    )
    document.querySelectorAll('.reveal').forEach((el) => {
      observer.observe(el)
    })

    // Safety net: if observer never fires (e.g. element already in view at load),
    // force all un-triggered reveals visible after 2.5s
    setTimeout(() => {
      document.querySelectorAll('.reveal:not(.in-view)').forEach((el) => {
        el.classList.add('in-view')
      })
    }, 2500)
  }

  /* ── Mockup row animation ── */
  function initMockupRows() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.querySelectorAll('.mockup-row').forEach((r) => {
        r.classList.add('visible')
      })
      return
    }
    const rows = document.querySelectorAll('.mockup-row')
    if (!rows.length) return
    let started = false
    const startRows = () => {
      if (started) return
      started = true
      rows.forEach((row, i) => {
        setTimeout(() => row.classList.add('visible'), 600 + i * 180)
      })
    }
    // Start after hero load — slight delay for drama
    setTimeout(startRows, 400)
  }

  /* ── Hero headline word-by-word entrance (GSAP) ── */
  function initHeroGSAP() {
    if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    gsap.registerPlugin(ScrollTrigger)

    // Arch arrows only — scaleX effect not covered by CSS reveal system
    gsap.from('.arch-arrow', {
      scrollTrigger: {
        trigger: '.arch-diagram',
        start: 'top 80%'
      },
      scaleX: 0,
      duration: 0.4,
      ease: 'power2.out',
      stagger: 0.15,
      delay: 0.2,
      immediateRender: false
    })
  }

  /* ── Marquee duplicate check (ensure enough items) ── */
  function initMarquee() {
    const track = document.querySelector('.marquee-track')
    if (!track) return
    // CSS handles the loop — just ensure animation runs correctly
    track.style.willChange = 'transform'
  }

  /* ── Init ── */
  function init() {
    initNav()
    initReveals()
    initMockupRows()
    initMarquee()
    // GSAP + Lenis load from CDN async — wait for them
    waitForLibs()
  }

  function waitForLibs() {
    let attempts = 0
    const interval = setInterval(() => {
      attempts++
      if (typeof gsap !== 'undefined' && typeof ScrollTrigger !== 'undefined') {
        clearInterval(interval)
        initHeroGSAP()
      }
      if (typeof Lenis !== 'undefined') {
        clearInterval(interval)
        initLenis()
        if (typeof gsap !== 'undefined') initHeroGSAP()
      }
      if (attempts > 40) clearInterval(interval) // 4s max wait
    }, 100)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
