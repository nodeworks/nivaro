import { useMutation, useQuery } from '@tanstack/react-query'
import React, { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import './globals.css'
import App from './App'
import { registerCloudPlugin, registerExtensionPlugin } from './extensions/store'

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
