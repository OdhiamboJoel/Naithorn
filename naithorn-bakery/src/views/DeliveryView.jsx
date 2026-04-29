import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../App'

const STATUS_COLOR = { loading:'#64748b', transit:'#38bdf8', arrived:'#f59e0b', confirmed:'#22c55e', complete:'#10b981' }

export default function DeliveryView() {
  const { user, logout } = useAuth()
  const [inventory, setInventory] = useState([])
  const [products, setProducts] = useState([])
  const [active, setActive]     = useState(null)   // active delivery record
  const [step, setStep]         = useState('home') // home | build | transit | arrived
  const [items, setItems]       = useState({})     // product_id → crate count (string)
  const [returnForm, setReturnForm] = useState({ empty: '', broken: '' })
  const [elapsed, setElapsed]   = useState(0)
  const [history, setHistory]   = useState([])
  const [loading, setLoading]   = useState(false)
  const [toast, setToast]       = useState('')

  const today = new Date().toISOString().slice(0, 10)

  const loadData = useCallback(async () => {
    const [inv, prods, act, hist] = await Promise.all([
      supabase.from('inventory').select('*, product:products(*)'),
      supabase.from('products').select('*').order('name'),
      supabase.from('deliveries')
        .select('*, items:delivery_items(*, product:products(name))')
        .eq('driver_id', user.id)
        .in('status', ['loading', 'transit', 'arrived'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from('deliveries')
        .select('*, items:delivery_items(*, product:products(name))')
        .eq('driver_id', user.id)
        .in('status', ['confirmed', 'complete'])
        .gte('created_at', today + 'T00:00:00')
        .order('created_at', { ascending: false }),
    ])
    if (inv.data)  setInventory(inv.data)
    if (prods.data) setProducts(prods.data)
    if (hist.data) setHistory(hist.data)

    if (act.data) {
      setActive(act.data)
      if (['loading','transit'].includes(act.data.status)) setStep('transit')
      else if (act.data.status === 'arrived') setStep('arrived')
    } else {
      setActive(null)
      setStep('home')
    }
  }, [user.id, today])

  useEffect(() => {
    loadData()
    const ch = supabase.channel('delivery-rt')
      .on('postgres_changes', { event:'*', schema:'public', table:'deliveries' }, loadData)
      .on('postgres_changes', { event:'*', schema:'public', table:'inventory' }, loadData)
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [loadData])

  // Elapsed timer
  useEffect(() => {
    if (!active?.departed_at) { setElapsed(0); return }
    const tick = () => setElapsed(Math.floor((Date.now() - new Date(active.departed_at).getTime()) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [active?.departed_at])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2800) }
  const fmtElapsed = (s) => `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`
  const totalCrates = Object.values(items).reduce((s, v) => s + (parseInt(v) || 0), 0)

  // ── Actions ──

  const confirmLoad = async () => {
    if (totalCrates === 0) return
    setLoading(true)
    const { data: delivery, error } = await supabase.from('deliveries')
      .insert({ driver_id: user.id, status: 'loading', crates_taken: totalCrates })
      .select().single()

    if (delivery) {
      const rows = Object.entries(items)
        .filter(([, v]) => parseInt(v) > 0)
        .map(([product_id, crates]) => ({ delivery_id: delivery.id, product_id, crates: parseInt(crates) }))
      await supabase.from('delivery_items').insert(rows)
      showToast(`${totalCrates} crates loaded`)
    } else {
      showToast('⚠ Error — try again')
    }
    setLoading(false)
    loadData()
  }

  const depart = async () => {
    if (!active) return
    setLoading(true)
    const now = new Date().toISOString()
    await supabase.from('deliveries').update({ status: 'transit', departed_at: now }).eq('id', active.id)

    // Move crates: store → transit
    for (const item of (active.items || [])) {
      const inv = inventory.find(i => i.product_id === item.product_id)
      if (inv) {
        await supabase.from('inventory').update({
          store_crates:   Math.max(0, (inv.store_crates || 0) - item.crates),
          transit_crates: (inv.transit_crates || 0) + item.crates,
          updated_at: now,
        }).eq('product_id', item.product_id)
      }
    }
    showToast('🚚 Departed — timer started')
    setLoading(false)
    loadData()
  }

  const arrive = async () => {
    setLoading(true)
    await supabase.from('deliveries').update({
      status: 'arrived',
      arrived_at: new Date().toISOString(),
    }).eq('id', active.id)
    showToast('✓ Marked as arrived')
    setLoading(false)
    loadData()
  }

  const complete = async () => {
    setLoading(true)
    await supabase.from('deliveries').update({
      status:               'complete',
      completed_at:         new Date().toISOString(),
      empty_crates_returned: parseInt(returnForm.empty)  || 0,
      broken_cakes:          parseInt(returnForm.broken) || 0,
    }).eq('id', active.id)
    showToast('✓ Trip complete!')
    setReturnForm({ empty:'', broken:'' })
    setLoading(false)
    loadData()
  }

  const cancelBuild = () => { setStep('home'); setItems({}) }

  return (
    <div className="view theme-delivery">
      <div className="view-header">
        <div>
          <div className="view-title text-accent">Delivery</div>
          <div className="view-sub">{user.name}</div>
        </div>
        <button onClick={logout} className="btn btn-ghost btn-sm">Sign out</button>
      </div>

      <div className="view-body">

        {/* ── HOME: store stock ── */}
        {step === 'home' && (
          <>
            <div className="section-head">Store stock</div>
            {inventory.length === 0 && <div className="empty">No stock in store yet</div>}
            {inventory.map(inv => (
              <div key={inv.id} className="list-item">
                <div className="dot" style={{ background:'var(--worker)' }} />
                <div style={{ flex:1 }}>
                  <div className="list-item-title">{inv.product?.name}</div>
                  <div className="list-item-sub">{inv.store_crates || 0} crates available</div>
                </div>
                <div style={{ fontWeight:'700', color:'var(--delivery)', fontSize:'1.1rem' }}>
                  {inv.store_crates || 0}
                </div>
              </div>
            ))}

            <button className="btn btn-primary" style={{ marginTop:'1rem' }}
              onClick={() => { setStep('build'); setItems({}) }}>
              Start new delivery →
            </button>

            {history.length > 0 && (
              <>
                <div className="section-head">Completed today</div>
                {history.map(d => (
                  <div key={d.id} className="list-item">
                    <div className="dot" style={{ background: STATUS_COLOR[d.status] }} />
                    <div style={{ flex:1 }}>
                      <div className="list-item-title">{d.crates_taken} crates</div>
                      <div className="list-item-sub">
                        Dep {d.departed_at ? new Date(d.departed_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'}) : '—'}
                        {d.arrived_at ? ` · Arr ${new Date(d.arrived_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}` : ''}
                        {d.broken_cakes > 0 ? ` · ${d.broken_cakes} broken` : ''}
                      </div>
                    </div>
                    <span className="badge" style={{ background:`${STATUS_COLOR[d.status]}20`, color: STATUS_COLOR[d.status] }}>{d.status}</span>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {/* ── BUILD: select crates per product ── */}
        {step === 'build' && (
          <>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'0.875rem' }}>
              <div style={{ fontWeight:'700' }}>Load crates</div>
              <button onClick={cancelBuild} style={{ background:'none', border:'none', color:'var(--text2)', cursor:'pointer', fontSize:'0.82rem' }}>Cancel</button>
            </div>

            {products.map(p => {
              const inv = inventory.find(i => i.product_id === p.id)
              const max = inv?.store_crates || 0
              return (
                <div key={p.id} className="card" style={{ display:'flex', alignItems:'center', gap:'1rem', marginBottom:'0.45rem', padding:'0.875rem 1rem' }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:'500', fontSize:'0.9rem' }}>{p.name}</div>
                    <div style={{ fontSize:'0.72rem', color:'var(--text2)' }}>{max} available in store</div>
                  </div>
                  <input
                    type="number" inputMode="numeric" min="0" max={max}
                    placeholder="0" style={{ width:'72px', textAlign:'center' }}
                    value={items[p.id] || ''}
                    onChange={e => setItems(it => ({ ...it, [p.id]: e.target.value }))}
                  />
                </div>
              )
            })}

            <div style={{ textAlign:'center', color:'var(--text2)', fontSize:'0.85rem', margin:'0.75rem 0' }}>
              {totalCrates} crates selected
            </div>
            <button className="btn btn-primary" disabled={totalCrates === 0 || loading} onClick={confirmLoad}>
              {loading ? 'Saving...' : 'Confirm load'}
            </button>
          </>
        )}

        {/* ── TRANSIT ── */}
        {step === 'transit' && active && (
          <>
            {/* Timer card */}
            <div className="card" style={{ textAlign:'center', border: active.status === 'transit' ? '1px solid var(--delivery)40' : '1px solid var(--border)' }}>
              {active.status === 'loading' ? (
                <>
                  <div style={{ fontSize:'0.78rem', color:'var(--text2)', marginBottom:'0.75rem' }}>
                    {active.crates_taken} crates loaded and ready
                  </div>
                  <button className="btn btn-primary" onClick={depart} disabled={loading}>
                    🚚 Depart now
                  </button>
                </>
              ) : (
                <>
                  <div style={{ fontSize:'0.72rem', color:'var(--delivery)', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:'0.5rem' }}>In transit</div>
                  <div className="monospace" style={{ fontSize:'2.8rem', fontWeight:'700', color:'var(--delivery)', lineHeight:1 }}>
                    {fmtElapsed(elapsed)}
                  </div>
                  <div style={{ fontSize:'0.78rem', color:'var(--text2)', marginTop:'0.4rem' }}>
                    Departed {new Date(active.departed_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}
                  </div>
                  <button className="btn btn-primary" style={{ marginTop:'1.1rem' }} onClick={arrive} disabled={loading}>
                    ✓ Arrived at market
                  </button>
                </>
              )}
            </div>

            {/* Load manifest */}
            <div className="section-head">This load</div>
            {active.items?.map(item => (
              <div key={item.id} className="list-item">
                <div className="dot" style={{ background:'var(--delivery)' }} />
                <div style={{ flex:1 }}>
                  <div className="list-item-title">{item.product?.name}</div>
                </div>
                <div style={{ fontWeight:'700', fontSize:'1rem' }}>{item.crates} crates</div>
              </div>
            ))}
          </>
        )}

        {/* ── ARRIVED ── */}
        {step === 'arrived' && active && (
          <>
            <div className="card" style={{ textAlign:'center', background:'rgba(34,197,94,0.08)', border:'1px solid rgba(34,197,94,0.25)' }}>
              <div style={{ fontSize:'1.8rem', marginBottom:'0.5rem' }}>✓</div>
              <div style={{ fontWeight:'700', fontSize:'1rem' }}>Arrived at market</div>
              <div style={{ fontSize:'0.8rem', color:'var(--text2)', marginTop:'0.25rem' }}>
                Waiting for sales team to confirm receipt
              </div>
            </div>

            <div className="card">
              <div className="card-title">Log return trip</div>
              <div className="field-row">
                <div>
                  <label>Empty crates back</label>
                  <input type="number" inputMode="numeric" min="0" placeholder="0"
                    value={returnForm.empty}
                    onChange={e => setReturnForm(r => ({ ...r, empty: e.target.value }))} />
                </div>
                <div>
                  <label>Broken cakes found</label>
                  <input type="number" inputMode="numeric" min="0" placeholder="0"
                    value={returnForm.broken}
                    onChange={e => setReturnForm(r => ({ ...r, broken: e.target.value }))} />
                </div>
              </div>
              <button className="btn btn-primary" onClick={complete} disabled={loading}>
                {loading ? 'Saving...' : 'Complete trip'}
              </button>
            </div>
          </>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
