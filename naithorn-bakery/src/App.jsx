import { useState, createContext, useContext, useEffect } from 'react'
import { supabase } from './lib/supabase'
import Login from './components/Login'
import WorkerView from './views/WorkerView'
import DeliveryView from './views/DeliveryView'
import SalesView from './views/SalesView'
import AdminView from './views/AdminView'

export const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

const VIEWS = {
  worker: WorkerView,
  delivery: DeliveryView,
  sales: SalesView,
  admin: AdminView
}

export default function App() {

  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('nb_session')
      return saved && saved !== "null" ? JSON.parse(saved) : null
    } catch {
      return null
    }
  })

  const login = async (profile) => {
    console.log("LOGIN PROFILE:", profile)

    if (!profile || !profile.id) {
      console.error("Invalid profile received:", profile)
      return
    }

    setUser(profile)
    localStorage.setItem('nb_session', JSON.stringify(profile))

    await supabase.from('attendance').insert({
      profile_id: profile.id
    })
  }

  const logout = async () => {
    if (user) {
      await supabase
        .from('attendance')
        .update({ logout_at: new Date().toISOString() })
        .eq('profile_id', user.id)
        .is('logout_at', null)
    }

    setUser(null)
    localStorage.removeItem('nb_session')
  }

  const ViewComponent = user?.role ? VIEWS[user.role.toLowerCase()] : null

  console.log("USER:", user)
  console.log("ROLE:", user?.role)
  console.log("VIEW:", ViewComponent)
  window.supabase = supabase

  return (
    <AuthContext.Provider value={{ user, logout }}>
      {!user ? <Login onLogin={login} /> : (ViewComponent ? <ViewComponent /> : <div>Invalid role</div>)}
    </AuthContext.Provider>
  )
}