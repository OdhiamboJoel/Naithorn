import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../App'

const RETAIL    = 50
const WHOLESALE = 43

export default function SalesView() {
  const { user, logout } = useAuth()
  const [tab, setTab] = useState('sell') // sell | stock | feed

  const [products, setProducts]   = useState([])
  const [inventory, setInventory] = useState([])
  const [customers, setCustomers] = useState([])
  const [arrivals, setArrivals]   = useState([])  // deliveries awaiting confirmation
  const [feed, setFeed]           = useState([])

  const [search, setSearch]     = useState('')
  const [customer, setCustomer] = useState(null)
  const [saleForm, setSaleForm] = useState({ product_id:'', qty:'', price_type:'retail' })
  const [loading, setLoading]   = useState(false)
  const [toast, setToast]       = useState('')

  const today = new Date().toISOString().slice(0, 10)

  const loadAll = useCallback(async () => {
    const [prods, inv, custs, arr, feed] = await Promise.all([
      supabase.from('products').select('*').order('name'),
      supabase.from('inventory').select('*, product:products(*)'),
      supabase.from('customers').select('*').order('name'),
      supabase.from('deliveries')
        .select('*, items:delivery_items(*, products(name))')
        .eq('status', 'arrived'),
      supabase.from('sales')
        .select('*, customers(name), products(name)')
        .gte('created_at', today + 'T00:00:00')
        .order('created_at', { ascending: false }),
    ])
    if (prods.data)  setProducts(prods.data)
    if (inv.data)    setInventory(inv.data)
    if (custs.data)  setCustomers(custs.data)
    if (arr.data)    setArrivals(arr.data)
    if (feed.data)   setFeed(feed.data)
  }, [today])

  useEffect(() => {
    loadAll()
    const ch = supabase.channel('sales-rt')
      .on('postgres_changes', { event:'*', schema:'public', table:'sales' }, loadAll)
      .on('postgres_changes', { event:'*', schema:'public', table:'inventory' }, loadAll)
      .on('postgres_changes', { event:'*', schema:'public', table:'deliveries' }, loadAll)
      .on('postgres_changes', { event:'*', schema:'public', table:'customers' }, loadAll)
      .on('postgres_changes', { event:'*', schema:'public', table:'mpesa_payments' }, loadAll)
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [loadAll])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2800) }

  const totalRevenue = feed.reduce((s, s2) => s + parseFloat(s2.total_amount), 0)
  const totalMarketCrates = inventory.reduce((s, i) => s + (i.market_crates || 0), 0)

  const filteredCustomers = search.trim().length >= 2
    ? customers.filter(c =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        (c.phone || '').includes(search)
      ).slice(0, 8)
    : []

  const unitPrice = saleForm.price_type === 'retail' ? RETAIL : WHOLESALE
  const saleTotal = (parseInt(saleForm.qty) || 0) * unitPrice

  // ── Record sale ──
  const recordSale = async () => {
    if (!customer || !saleForm.product_id || !saleForm.qty) return
    const qty = parseInt(saleForm.qty)
    if (qty <= 0) return

    if (customer.mpesa_balance < saleTotal) {
      showToast('⚠ Insufficient Mpesa balance')
      return
    }

    setLoading(true)
    const { error } = await supabase.from('sales').insert({
      sales_person_id: user.id,
      customer_id:     customer.id,
      product_id:      saleForm.product_id,
      cakes_sold:      qty,
      price_type:      saleForm.price_type,
      unit_price:      unitPrice,
      total_amount:    saleTotal,
    })

    if (!error) {
      // Deduct from customer Mpesa balance
      const newBal = parseFloat(customer.mpesa_balance) - saleTotal
      await supabase.from('customers').update({ mpesa_balance: newBal }).eq('id', customer.id)

      // Deduct from market inventory (approx by crate)
      const product = products.find(p => p.id === saleForm.product_id)
      if (product) {
        const inv = inventory.find(i => i.product_id === saleForm.product_id)
        if (inv) {
          const cratesToDeduct = Math.floor(qty / product.cakes_per_crate)
          if (cratesToDeduct > 0) {
            await supabase.from('inventory').update({
              market_crates: Math.max(0, (inv.market_crates || 0) - cratesToDeduct),
              updated_at: new Date().toISOString(),
            }).eq('product_id', saleForm.product_id)
          }
        }
      }

      setCustomer(c => c ? { ...c, mpesa_balance: newBal } : c)
      setSaleForm(f => ({ ...f, qty:'' }))
      showToast(`✓ KES ${saleTotal.toLocaleString()} — sale recorded`)
    } else {
      showToast('⚠ Error — try again')
    }
    setLoading(false)
    loadAll()
  }

  // ── Confirm delivery arrival ──
  const confirmDelivery = async (delivery) => {
    setLoading(true)
    await supabase.from('deliveries').update({ status:'confirmed' }).eq('id', delivery.id)

    // Move transit → market for each item
    for (const item of (delivery.items || [])) {
      const inv = inventory.find(i => i.product_id === item.product_id)
      if (inv) {
        await supabase.from('inventory').update({
          market_crates:   (inv.market_crates   || 0) + item.crates,
          transit_crates:  Math.max(0, (inv.transit_crates || 0) - item.crates),
          updated_at: new Date().toISOString(),
        }).eq('product_id', item.product_id)
      }
    }
    showToast('✓ Delivery confirmed — stock updated')
    setLoading(false)
    loadAll()
  }

  return (
    <div className="view theme-sales">
      <div className="view-header">
        <div>
          <div className="view-title text-accent">Sales</div>
          <div className="view-sub">{user.name} · KES {totalRevenue.toLocaleString()} today</div>
        </div>
        <button onClick={logout} className="btn btn-ghost btn-sm">Sign out</button>
      </div>

      <div className="tab-bar">
        {[['sell','Record sale'],['stock','Live stock'],['feed','Today']].map(([v, l]) => (
          <button key={v} className={`tab-btn ${tab===v?'active':''}`} onClick={() => setTab(v)}>{l}</button>
        ))}
      </div>

      <div className="view-body">

        {/* ── SELL TAB ── */}
        {tab === 'sell' && (
          <>
            {/* Incoming deliveries banner */}
            {arrivals.length > 0 && arrivals.map(d => (
              <div key={d.id} className="card" style={{ border:'1px solid var(--sales)50', marginBottom:'0.75rem' }}>
                <div className="card-title" style={{ color:'var(--sales)' }}>⚡ Delivery arrived — confirm receipt</div>
                <div style={{ fontSize:'0.85rem', color:'var(--text2)', marginBottom:'0.625rem' }}>
                  {d.items?.map(i => `${i.crates} crates ${i.product?.name}`).join(' · ')}
                </div>
                <button className="btn btn-primary" disabled={loading} onClick={() => confirmDelivery(d)}>
                  ✓ Confirm receipt
                </button>
              </div>
            ))}

            {/* Customer search */}
            <div className="field">
              <label>Search customer</label>
              <input
                value={search}
                onChange={e => { setSearch(e.target.value); if (!e.target.value) setCustomer(null) }}
                placeholder="Type name or phone number..."
              />
            </div>

            {/* Dropdown results */}
            {search.length >= 2 && !customer && (
              <div style={{ background:'var(--bg2)', borderRadius:'var(--radius-sm)', marginBottom:'0.75rem', border:'1px solid var(--border2)', overflow:'hidden' }}>
                {filteredCustomers.length === 0 && (
                  <div style={{ padding:'0.75rem 1rem', fontSize:'0.85rem', color:'var(--text2)' }}>No customer found</div>
                )}
                {filteredCustomers.map(c => (
                  <div key={c.id}
                    onClick={() => { setCustomer(c); setSearch(c.name) }}
                    style={{ padding:'0.75rem 1rem', cursor:'pointer', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div>
                      <div style={{ fontWeight:'600', fontSize:'0.9rem' }}>{c.name}</div>
                      <div style={{ fontSize:'0.72rem', color:'var(--text2)' }}>{c.phone || 'No phone'}</div>
                    </div>
                    <div style={{ fontWeight:'700', fontSize:'0.9rem', color: parseFloat(c.mpesa_balance) > 0 ? 'var(--success)' : 'var(--text3)' }}>
                      KES {parseFloat(c.mpesa_balance).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Sale form */}
            {customer && (
              <div className="card" style={{ border:'1px solid var(--sales)30' }}>
                {/* Customer header */}
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.875rem' }}>
                  <div>
                    <div style={{ fontWeight:'700', fontSize:'1rem' }}>{customer.name}</div>
                    <div style={{ fontSize:'0.8rem', marginTop:'2px' }}>
                      Mpesa balance:{' '}
                      <span style={{ color: parseFloat(customer.mpesa_balance) > 0 ? 'var(--success)' : 'var(--danger)', fontWeight:'700' }}>
                        KES {parseFloat(customer.mpesa_balance).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <button onClick={() => { setCustomer(null); setSearch(''); setSaleForm(f => ({...f, qty:''})) }}
                    style={{ background:'none', border:'none', color:'var(--text2)', cursor:'pointer', fontSize:'1.3rem', lineHeight:1 }}>×</button>
                </div>

                <div className="field">
                  <label>Product</label>
                  <select value={saleForm.product_id} onChange={e => setSaleForm(f => ({ ...f, product_id: e.target.value }))}>
                    <option value="">Select product...</option>
                    {products.map(p => {
                      const inv = inventory.find(i => i.product_id === p.id)
                      return <option key={p.id} value={p.id}>{p.name} ({inv?.market_crates || 0} crates at market)</option>
                    })}
                  </select>
                </div>

                <div className="field-row">
                  <div>
                    <label>Qty (cakes)</label>
                    <input type="number" inputMode="numeric" min="1" placeholder="0"
                      value={saleForm.qty} onChange={e => setSaleForm(f => ({ ...f, qty: e.target.value }))} />
                  </div>
                  <div>
                    <label>Price</label>
                    <select value={saleForm.price_type} onChange={e => setSaleForm(f => ({ ...f, price_type: e.target.value }))}>
                      <option value="retail">Retail — KES {RETAIL}</option>
                      <option value="wholesale">Wholesale — KES {WHOLESALE}</option>
                    </select>
                  </div>
                </div>

                {saleForm.qty && saleForm.product_id && (
                  <div className="highlight" style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.75rem' }}>
                    <span style={{ color:'var(--text2)', fontSize:'0.875rem' }}>
                      {saleForm.qty} × KES {unitPrice}
                    </span>
                    <span style={{ fontWeight:'800', fontSize:'1.2rem', color:'var(--sales)' }}>
                      KES {saleTotal.toLocaleString()}
                    </span>
                  </div>
                )}

                <button className="btn btn-primary"
                  disabled={!saleForm.product_id || !saleForm.qty || loading || parseFloat(customer.mpesa_balance) < saleTotal}
                  onClick={recordSale}>
                  {loading ? 'Recording...' : 'Record sale'}
                </button>
              </div>
            )}
          </>
        )}

        {/* ── STOCK TAB ── */}
        {tab === 'stock' && (
          <>
            <div className="stats-grid">
              <div className="stat">
                <div className="stat-val text-accent">{totalMarketCrates}</div>
                <div className="stat-lbl">Crates at market</div>
              </div>
              <div className="stat">
                <div className="stat-val text-accent" style={{ fontSize:'1.2rem' }}>
                  {inventory.reduce((s,i) => s + (i.market_crates||0)*(i.product?.cakes_per_crate||30)*RETAIL,0).toLocaleString()}
                </div>
                <div className="stat-lbl">Stock value (KES)</div>
              </div>
            </div>

            {inventory.map(inv => {
              const cakes = (inv.market_crates||0) * (inv.product?.cakes_per_crate||30)
              return (
                <div key={inv.id} className="card">
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                    <div style={{ fontWeight:'600', fontSize:'0.95rem' }}>{inv.product?.name}</div>
                    <div style={{ fontWeight:'800', fontSize:'1.3rem', color:'var(--sales)' }}>{inv.market_crates || 0}</div>
                  </div>
                  <div style={{ fontSize:'0.78rem', color:'var(--text2)', marginTop:'0.3rem' }}>
                    {cakes.toLocaleString()} cakes · KES {(cakes * RETAIL).toLocaleString()} retail value
                  </div>
                  <div style={{ marginTop:'0.5rem', display:'flex', gap:'0.5rem' }}>
                    <span className="badge" style={{ background:'var(--sales-dim)', color:'var(--sales)' }}>Market: {inv.market_crates||0}</span>
                    <span className="badge" style={{ background:'rgba(56,189,248,0.12)', color:'var(--delivery)' }}>Transit: {inv.transit_crates||0}</span>
                    <span className="badge" style={{ background:'rgba(16,185,129,0.12)', color:'var(--worker)' }}>Store: {inv.store_crates||0}</span>
                  </div>
                </div>
              )
            })}
          </>
        )}

        {/* ── FEED TAB ── */}
        {tab === 'feed' && (
          <>
            <div style={{ display:'flex', justifyContent:'space-between', padding:'0.875rem 0', marginBottom:'0.5rem' }}>
              <div>
                <div style={{ fontSize:'0.68rem', color:'var(--text2)', textTransform:'uppercase', letterSpacing:'0.08em' }}>Revenue today</div>
                <div style={{ fontSize:'1.6rem', fontWeight:'800', color:'var(--sales)', letterSpacing:'-0.02em' }}>KES {totalRevenue.toLocaleString()}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:'0.68rem', color:'var(--text2)', textTransform:'uppercase', letterSpacing:'0.08em' }}>Transactions</div>
                <div style={{ fontSize:'1.6rem', fontWeight:'800' }}>{feed.length}</div>
              </div>
            </div>
            <hr />
            {feed.length === 0 && <div className="empty">No sales yet today</div>}
            {feed.map(s => (
              <div key={s.id} className="list-item">
                <div style={{ flex:1 }}>
                  <div className="list-item-title">{s.customer?.name}</div>
                  <div className="list-item-sub">
                    {s.cakes_sold} × {s.product?.name} · {s.price_type} · {new Date(s.created_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}
                  </div>
                </div>
                <div style={{ fontWeight:'700', color:'var(--success)', fontSize:'0.9rem', flexShrink:0 }}>+{parseFloat(s.total_amount).toLocaleString()}</div>
              </div>
            ))}
          </>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
