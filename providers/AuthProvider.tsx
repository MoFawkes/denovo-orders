import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

type Role = 'packer' | 'manager' | 'admin' | 'designer' | null

type AuthContextType = {
  session: Session | null
  user: User | null
  role: Role
  loading: boolean
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [role, setRole] = useState<Role>(null)
  const [loading, setLoading] = useState(true)

  async function loadProfile(userId: string) {
    const { data, error } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single()

    if (error) {
      console.error('[AuthProvider] load profile:', error)
      setRole(null)
      return
    }

    setRole((data?.role as Role) ?? null)
  }

  async function refreshProfile() {
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser()

    if (!currentUser) {
      setRole(null)
      return
    }

    await loadProfile(currentUser.id)
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      setUser(data.session?.user ?? null)

      if (data.session?.user) {
        await loadProfile(data.session.user.id)
      }

      setLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setUser(nextSession?.user ?? null)

      if (nextSession?.user) {
        loadProfile(nextSession.user.id)
      } else {
        setRole(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const value = useMemo(
    () => ({
      session,
      user,
      role,
      loading,
      signOut: async () => {
        await supabase.auth.signOut()
      },
      refreshProfile,
    }),
    [session, user, role, loading]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }

  return context
}