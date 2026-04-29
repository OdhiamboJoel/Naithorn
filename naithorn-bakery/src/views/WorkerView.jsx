import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../App'

export default function WorkerView() {
  const { user, logout } = useAuth()
  const [products, setProducts] = useState([])
  const [logs, setLogs] = useState([])
  const [form, setForm] = useState({ product_id: '', mixes: '' })
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [toast, setToast] = useState('')

  const today = new Date().toISOString().slice(0, 10)

  useEffect(() => {
    supabase.from('products').select('*').order('name').then(({ data }) => {
      if (data?.length) { setProducts(data); setForm(f => ({ ...f, product_id: data[0].id })) }
    })
    loadLogs()

    const ch = supabase.channel('worker-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'production_logs' }, loadLogs)
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [])

  const loadLogs = async () => {
    const { data } = await supabase
      .from('production_logs')
      .select('*, product:products(name)')
      .gte('created_at', today + 'T00:00:00')
      .order('created_at', { ascending: false })
    if (data) setLogs(data)
  }

  // Live preview calculation
  useEffect(() => {
    const product = products.find(p => p.id === form.product_id)
    const mixes = parseInt(form.mixes)
    if (product && mixes > 0) {
      const total_cakes  = mixes * product.cakes_per_mix
      const full_crates  = Math.floor(total_cakes / product.cakes_per_crate)
      const loose_cakes  = total_cakes % product.cakes_per_crate
      const flour_used   = parseFloat((mixes * parseFloat(product.flour_per_mix_kg)).toFixed(2))
      setPreview({ total_cakes, full_crates, loose_cakes, flour_used })
    } else {
      setPreview(null)
    }
  }, [form, products])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2800) }

  const submit = async () => {
    const product = products.find(p => p.id === form.product_id)
    if (!product || !preview) return
    setLoading(true)
    const mixes = parseInt(form.mixes)

    // Insert production log
    const { error } = await supabase.from('production_logs').insert({
      worker_id:    user.id,
      product_id:   product.id,
      mixes,
      cakes_produced: preview.total_cakes,
      full_crates:  preview.full_crates,
      loose_cakes:  preview.loose_cakes,
      flour_used_kg: preview.flour_used,
    })

    if (!error) {
      // Update store inventory using upsert
      const { data: existing } = await supabase
        .from('inventory').select('*').eq('product_id', product.id).maybeSingle()

      if (existing) {
        await supabase.from('inventory').update({
          store_crates: (existing.store_crates || 0) + preview.full_crates,
          loose_store:  (existing.loose_store  || 0) + preview.loose_cakes,
          updated_at:   new Date().toISOString(),
        }).eq('product_id', product.id)
      } else {
        await supabase.from('inventory').insert({
          product_id:   product.id,
          store_crates: preview.full_crates,
          loose_store:  preview.loose_cakes,
        })
      }

      setForm(f => ({ ...f, mixes: '' }))
      showToast(`✓ Logged — ${preview.full_crates} crates of ${product.name}`)
    } else {
      showToast('⚠ Error saving — try again')
    }

    setLoading(false)
    loadLogs()
  }

  const todayCakes  = logs.reduce((s, l) => s + l.cakes_produced, 0)
  const todayCrates = logs.reduce((s, l) => s + l.full_crates, 0)
  const todayMixes  = logs.reduce((s, l) => s + l.mixes, 0)

  return (
    <div className="view theme-worker">
      <div className="view-header">
        <div>
          <div className="view-title text-accent">Production</div>
          <div className="view-sub">{user.name} · {new Date().toLocaleDateString('en-KE', { weekday:'short', day:'numeric', month:'short' })}</div>
        </div>
        <button onClick={logout} className="btn btn-ghost btn-sm">Sign out</button>
      </div>

      <div className="view-body">
        {/* Today stats */}
        <div className="stats-grid">
          <div className="stat">
            <div className="stat-val text-accent">{todayCakes.toLocaleString()}</div>
            <div className="stat-lbl">Cakes today</div>
          </div>
          <div className="stat">
            <div className="stat-val text-accent">{todayCrates}</div>
            <div className="stat-lbl">Crates packed</div>
          </div>
        </div>

        {/* Log batch form */}
        <div className="card">
          <div className="card-title">Log new batch</div>

          <div className="field">
            <label>Product</label>
            <select value={form.product_id} onChange={e => setForm(f => ({ ...f, product_id: e.target.value }))}>
              {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <div className="field">
            <label>How many mixes?</label>
            <input
              type="number" inputMode="numeric" min="1" max="50"
              placeholder="e.g. 6"
              value={form.mixes}
              onChange={e => setForm(f => ({ ...f, mixes: e.target.value }))}
            />
          </div>

          {/* Preview */}
          {preview && (
            <div className="highlight">
              <div className="highlight-title">This batch gives you</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'0.5rem', textAlign:'center' }}>
                {[
                  [preview.total_cakes, 'total cakes'],
                  [preview.full_crates, 'full crates'],
                  [preview.loose_cakes, 'loose cakes'],
                ].map(([val, lbl]) => (
                  <div key={lbl}>
                    <div style={{ fontSize:'1.4rem', fontWeight:'700', color:'var(--accent)' }}>{val}</div>
                    <div style={{ fontSize:'0.68rem', color:'var(--text2)', marginTop:'2px' }}>{lbl}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button className="btn btn-primary" disabled={!preview || loading} onClick={submit}>
            {loading ? 'Saving...' : '✓ Submit batch'}
          </button>
        </div>

        {/* Today's log */}
        <div className="section-head">Today's batches ({logs.length})</div>

        {logs.length === 0 && <div className="empty">No batches logged yet today</div>}

        {logs.map(log => (
          <div key={log.id} className="list-item">
            <div className="dot dot-green" />
            <div style={{ flex:1 }}>
              <div className="list-item-title">{log.product?.name}</div>
              <div className="list-item-sub">
                {log.mixes} mix{log.mixes > 1 ? 'es' : ''} &middot; {log.cakes_produced.toLocaleString()} cakes &middot; {log.full_crates} crates
                {log.loose_cakes > 0 ? ` + ${log.loose_cakes} loose` : ''}
              </div>
            </div>
            <div style={{ fontSize:'0.78rem', color:'var(--text3)', flexShrink:0 }}>
              {new Date(log.created_at).toLocaleTimeString('en-KE', { hour:'2-digit', minute:'2-digit' })}
            </div>
          </div>
        ))}

        {todayMixes > 0 && (
          <div style={{ textAlign:'center', fontSize:'0.75rem', color:'var(--text3)', marginTop:'0.5rem' }}>
            {todayMixes} total mixes today
          </div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
