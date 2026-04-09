import 'react-native-url-polyfill/auto'
import { createClient } from '@supabase/supabase-js'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

const supabaseUrl = 'https://sfwnmddlmiprvsoxbatz.supabase.co'
const supabaseAnonKey = 'sb_publishable_duNC--xXncN1Et3VedYPNw_oaBtBcu1'

const ExpoSecureStoreAdapter = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
}

const WebStorageAdapter = {
  getItem: (key) => Promise.resolve(typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null),
  setItem: (key, value) => Promise.resolve(typeof localStorage !== 'undefined' ? localStorage.setItem(key, value) : undefined),
  removeItem: (key) => Promise.resolve(typeof localStorage !== 'undefined' ? localStorage.removeItem(key) : undefined),
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: Platform.OS === 'web' ? WebStorageAdapter : ExpoSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})