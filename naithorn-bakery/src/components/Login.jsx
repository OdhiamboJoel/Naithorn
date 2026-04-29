import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

const ROLE_COLOR = { worker: '#10b981', delivery: '#38bdf8', sales: '#f59e0b', admin: '#a78bfa' }
const ROLE_LABEL = { worker: 'Production', delivery: 'Delivery', sales: 'Sales Point', admin: 'Owner / Admin' }
const ROLE_ICON  = { worker: '⚙️', delivery: '🚚', sales: '🛒', admin: '📊' }

export default function Login({ onLogin }) {
  const [profiles, setProfiles] = useState([])
  const [selected, setSelected] = useState(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(true)

  useEffect(() => {
    supabase.from('profiles')
  .select('*')
      .then(({ data, error }) => {
  console.log("PROFILES DATA:", data)
  console.log("PROFILES ERROR:", error)
  if (data) setProfiles(data)
  setFetching(false)
})
  }, [])

  const pushDigit = (d) => { if (pin.length < 4) setPin(p => p + d) }
  const backspace  = ()  => setPin(p => p.slice(0, -1))

  useEffect(() => {
    if (pin.length === 4) doLogin()
  }, [pin])

  const doLogin = async () => {
    if (!selected) return
    setLoading(true); setError('')
    const { data } = await supabase
      .from('profiles').select('*')
      .eq('id', selected.id).eq('pin', pin)
      .maybeSingle()
      console.log("SUPABASE LOGIN RESULT:", data)
    if (data) {
      onLogin(data)
    } else {
      setError('Wrong PIN — try again')
      setPin('')
    }
    setLoading(false)
    console.log("SELECTED:", selected)
console.log("PIN:", pin)
  }

  const S = {
    wrap:   { minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'1.5rem', background:'var(--bg)' },
    logo:   { textAlign:'center', marginBottom:'2.25rem' },
    emoji:  { fontSize:'2.8rem', display:'block', marginBottom:'0.5rem' },
    title:  { fontSize:'1.4rem', fontWeight:'800', letterSpacing:'-0.02em' },
    sub:    { fontSize:'0.8rem', color:'var(--text2)', marginTop:'3px' },
    list:   { width:'100%', maxWidth:'360px' },
    card:   (role) => ({
      width:'100%', background:'var(--bg2)', border:`1px solid ${ROLE_COLOR[role]}30`,
      borderRadius:'12px', padding:'1rem 1.1rem', marginBottom:'0.6rem',
      cursor:'pointer', display:'flex', alignItems:'center', gap:'0.875rem',
      color:'var(--text)', textAlign:'left', transition:'border-color 0.15s',
    }),
    avatar: (role) => ({
      width:'40px', height:'40px', borderRadius:'50%', flexShrink:0,
      background:`${ROLE_COLOR[role]}18`,
      display:'flex', alignItems:'center', justifyContent:'center',
      fontSize:'1.1rem',
    }),
    pinWrap: { width:'100%', maxWidth:'300px' },
    back:   { background:'none', border:'none', color:'var(--text2)', cursor:'pointer', marginBottom:'1.5rem', display:'flex', alignItems:'center', gap:'0.4rem', fontSize:'0.85rem', padding:0 },
    bigAvatar: (role) => ({
      width:'60px', height:'60px', borderRadius:'50%',
      background:`${ROLE_COLOR[role]}18`,
      display:'flex', alignItems:'center', justifyContent:'center',
      fontSize:'1.6rem', margin:'0 auto 0.75rem',
    }),
    dots:   { display:'flex', justifyContent:'center', gap:'0.75rem', margin:'1.5rem 0' },
    dot:    (filled, color) => ({
      width:'13px', height:'13px', borderRadius:'50%',
      background: filled ? color : 'var(--bg3)',
      border:`2px solid ${filled ? color : 'var(--border2)'}`,
      transition:'all 0.12s',
    }),
    grid:   { display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'0.5rem' },
    key:    (k) => ({
      padding:'1rem', background:k ? 'var(--bg2)' : 'transparent',
      border:`1px solid ${k ? 'var(--border2)' : 'transparent'}`,
      borderRadius:'12px', color:'var(--text)',
      fontSize: k === '⌫' ? '1.1rem' : '1.3rem', fontWeight:'500',
      cursor: k ? 'pointer' : 'default', fontFamily:'inherit',
    }),
  }

  return (
    <div style={S.wrap}>
      <div style={S.logo}>
        <span style={S.emoji}>🍞</span>
        <div style={S.title}>Naithorn Bakery</div>
        <div style={S.sub}>Management System</div>
      </div>

      {!selected ? (
        <div style={S.list}>
          <div style={{ fontSize:'0.78rem', color:'var(--text2)', textAlign:'center', marginBottom:'0.875rem' }}>
            {fetching ? 'Loading...' : 'Select your profile'}
          </div>
          {profiles.map(p => (
            <button key={p.id} style={S.card(p.role)} onClick={() => setSelected(p)}>
              <div style={S.avatar(p.role)}>{ROLE_ICON[p.role]}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:'600', fontSize:'0.95rem' }}>{p.name}</div>
                <div style={{ fontSize:'0.75rem', color:ROLE_COLOR[p.role], marginTop:'1px' }}>{ROLE_LABEL[p.role]}</div>
              </div>
              <span style={{ color:'var(--text3)', fontSize:'1rem' }}>›</span>
            </button>
          ))}
        </div>
      ) : (
        <div style={S.pinWrap}>
          <button style={S.back} onClick={() => { setSelected(null); setPin(''); setError('') }}>
            ← Back
          </button>
          <div style={{ textAlign:'center' }}>
            <div style={S.bigAvatar(selected.role)}>{ROLE_ICON[selected.role]}</div>
            <div style={{ fontWeight:'700', fontSize:'1rem' }}>{selected.name}</div>
            <div style={{ fontSize:'0.78rem', color:ROLE_COLOR[selected.role], marginTop:'2px' }}>{ROLE_LABEL[selected.role]}</div>
          </div>

          <div style={S.dots}>
            {[0,1,2,3].map(i => <div key={i} style={S.dot(i < pin.length, ROLE_COLOR[selected.role])} />)}
          </div>

          {error && <div style={{ textAlign:'center', color:'var(--danger)', fontSize:'0.82rem', marginBottom:'0.875rem' }}>{error}</div>}
          {loading && <div style={{ textAlign:'center', color:'var(--text2)', fontSize:'0.82rem', marginBottom:'0.875rem' }}>Checking...</div>}

          <div style={S.grid}>
            {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((k, i) => (
              <button key={i} style={S.key(k)} disabled={loading || !k}
                onClick={() => k === '⌫' ? backspace() : k ? pushDigit(k) : null}
              >{k}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
