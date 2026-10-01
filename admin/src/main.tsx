import { useMutation, useQuery } from '@tanstack/react-query'
import React, { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import './globals.css'
import App from './App'
import { registerCloudPlugin, registerExtensionPlugin } from './extensions/store'
import { captureMasqueradeFromHash, installMasqueradeFetch } from './lib/masquerade'
import { installPageContextFetch } from './lib/page-context'

// A "View as" tab (#640) reads its token before anything fetches.
captureMasqueradeFromHash()
installMasqueradeFetch()
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
