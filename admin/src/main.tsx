// First: every later import may create an SDK client over window.fetch — the View-as bearer
// (#640) and browser chaos (#2840) must both wrap it before then.
import './lib/masquerade-boot'
import './lib/client-chaos-boot'
import { useMutation, useQuery } from '@tanstack/react-query'
import React, { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import './globals.css'
import { disableRecordOutbox, guardErrorToasts, installStaleChunkRecovery } from '@nivaro/shared'
import App from './App'
import { registerCloudPlugin, registerExtensionPlugin } from './extensions/store'
import { installGlobalErrorReport } from './lib/global-error-report'
import { readMasquerade } from './lib/masquerade'
import { installPageContextFetch } from './lib/page-context'

// A "View as" tab (#640; its token is read in lib/masquerade-boot.ts) never queues an
// offline save under the person it is viewing as (#1678):
// a failed save there shows the normal error.
if (readMasquerade()) disableRecordOutbox()
// A tab opened before a deploy asks for the previous build's screen files, which the new
// release no longer serves: reload onto the current build (once — a second failure says so).
installStaleChunkRecovery({
  onGiveUp: () =>
    toast.error('Nivaro was updated and this page could not load part of it.', {
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Reload', onClick: () => window.location.reload() }
    })
})
// Code errors outside a render (handlers, timers, unawaited promises) reach the issue log too.
installGlobalErrorReport()
// No error toast ever shows raw text ("Request failed with status code 500", SQL, a stack):
// it reads as what it means. Before any screen (or extension) can raise one.
guardErrorToasts()
// Every fetch to the API (SDK clients included) says which screen it came from (#1113 / #1116).
// #1048 / #1180 — and which build this tab runs, so old tabs can be counted and reloaded alone.
installPageContextFetch({
  app: 'admin',
  build: typeof __NIVARO_ADMIN_BUILD__ === 'string' ? __NIVARO_ADMIN_BUILD__ : 'dev'
})

window.__NIVARO__ = {
  React,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  registerPlugin: registerExtensionPlugin,
  registerCloudPlugin,
  useQuery,
  useMutation,
  useNavigate,
  toast
}

Object.freeze(window.__NIVARO__)

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
)
