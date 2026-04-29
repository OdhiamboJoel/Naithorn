import { useState, useEffect, useCallback } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from 'recharts'
import { supabase } from '../lib/supabase'
import { useAuth } from '../App'

const ROLE_COLOR = { worker:'#10b981', delivery:'#38bdf8', sales:'#f59e0b', admin:'#a78bfa' }
const STATUS_DOT = { loading:'#64748b', transit:'#38bdf8', arrived:'#f59e0b', confirmed:'#22c55e', complete:'#10b981' }
const RETAIL     = 50

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background:'#1e293b', border:'1px solid rgba(255,255,255,0.12)', borderRadius:'8px', padding:'0.5rem 0.75rem', fontSize:'0.78rem' }}>
      <div style={{ color:'#94a3b8', marginBottom:'2px' }}>{label}</div>
      <div style={{ fontWeight:'700', color:'#a78bfa' }}>KES {payload[0].value.toLocaleString()}</div>
    </div>
  )
}

export default function AdminView() {
  const { user, logout } = useAuth()
  const [tab, setTab] = useState('overview')
  const [d, setD] = useState({
    sales:[], inventory:[], production:[], flour:null, attendance:[], deliveries:[], products:[]
  })
  const [loading, setLoading]         = useState(true)
  const [liveIndicator, setLive]      = useState(false)
  const [flourInput, setFlourInput]   = useState('')
  const [showFlourEdit, setShowFlourEdit] = useState(false)

  const today = new Date().toISOString().slice(0, 10)

  const loadAll = useCallback(async () => {
    const [sales, inv, prod, flour, att, del, prods] = await Promise.all([
      supabase.from('sales')
        .select('*, customer:customers(name), product:products(name), sp:profiles!sales_person_id(name)')
        .gte('created_at', today + 'T00:00:00')
        .order('created_at', { ascending: false }),
      supabase.from('inventory').select('*, product:products(*)'),
      supabase.from('production_logs')
        .select('*, product:products(name), worker:profiles!worker_id(name)')
        .gte('created_at', today + 'T00:00:00')
        .order('created_at', { ascending: false }),
      supabase.from('flour_stock').select('*').order('created_at',{ascending:false}).limit(1).maybeSingle(),
      supabase.from('attendance')
        .select('*, profile:profiles(name,role)')
        .gte('login_at', today + 'T00:00:00'),
      supabase.from('deliveries')
        .select('*, driver:profiles!driver_id(name), items:delivery_items(*, product:products(name))')
        .gte('created_at', today + 'T00:00:00')
        .order('created_at', { ascending: false }),
      supabase.from('products').select('*').order('name'),
    ])
    setD({
      sales:      sales.data      || [],
      inventory:  inv.data        || [],
      production: prod.data       || [],
      flour:      flour.data      || null,
      attendance: att.data        || [],
      deliveries: del.data        || [],
      products:   prods.data      || [],
    })
    setLoading(false)
    // Flash live indicator
    setLive(true); setTimeout(() => setLive(false), 800)
  }, [today])

  useEffect(() => {
    loadAll()
    const ch = supabase.channel('admin-rt')
      .on('postgres_changes', { event:'*', schema:'public', table:'sales' },          loadAll)
      .on('postgres_changes', { event:'*', schema:'public', table:'inventory' },      loadAll)
      .on('postgres_changes', { event:'*', schema:'public', table:'production_logs' },loadAll)
      .on('postgres_changes', { event:'*', schema:'public', table:'deliveries' },     loadAll)
      .on('postgres_changes', { event:'*', schema:'public', table:'attendance' },     loadAll)
      .on('postgres_changes', { event:'*', schema:'public', table:'flour_stock' },    loadAll)
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [loadAll])

  const saveFlour = async () => {
    if (!flourInput) return
    await supabase.from('flour_stock').insert({ quantity_kg: parseFloat(flourInput), updated_by: user.id })
    setFlourInput(''); setShowFlourEdit(false); loadAll()
  }

  // ── Derived stats ──
  const todayRevenue      = d.sales.reduce((s,x) => s + parseFloat(x.total_amount), 0)
  const todayCakes        = d.production.reduce((s,x) => s + x.cakes_produced, 0)
  const todayCrates       = d.production.reduce((s,x) => s + x.full_crates, 0)
  const flourKg           = d.flour ? parseFloat(d.flour.quantity_kg) : 0
  const flourUsedToday    = d.production.reduce((s,x) => s + parseFloat(x.flour_used_kg), 0)
  const flourDays         = flourUsedToday > 0 ? Math.floor(flourKg / flourUsedToday) : null

  const totalStoreCrates  = d.inventory.reduce((s,i) => s + (i.store_crates   ||0), 0)
  const totalTransit      = d.inventory.reduce((s,i) => s + (i.transit_crates ||0), 0)
  const totalMarket       = d.inventory.reduce((s,i) => s + (i.market_crates  ||0), 0)

  // Hourly chart
  const currentHour = new Date().getHours()
  const hourly = Array.from({ length: currentHour + 1 }, (_, h) => {
    const rev = d.sales
      .filter(s => new Date(s.created_at).getHours() === h)
      .reduce((s, x) => s + parseFloat(x.total_amount), 0)
    return { hour: `${String(h).padStart(2,'0')}h`, revenue: rev }
  })

  // Product breakdown bar chart
  const prodStats = {}
  d.sales.forEach(s => {
    const n = s.product?.name || 'Other'
    if (!prodStats[n]) prodStats[n] = { revenue:0, cakes:0 }
    prodStats[n].revenue += parseFloat(s.total_amount)
    prodStats[n].cakes   += s.cakes_sold
  })
  const prodList = Object.entries(prodStats).sort((a,b) => b[1].revenue - a[1].revenue)

  // Live deliveries
  const liveDeliveries = d.deliveries.filter(d => ['transit','arrived'].includes(d.status))

  // Attendance duration
  const duration = (att) => {
    const loginMs  = new Date(att.login_at).getTime()
    const logoutMs = att.logout_at ? new Date(att.logout_at).getTime() : Date.now()
    const mins     = Math.floor((logoutMs - loginMs) / 60000)
    return `${Math.floor(mins/60)}h ${mins%60}m`
  }

  return (
    <div className="view theme-admin">
      <div className="view-header">
        <div>
          <div className="view-title text-accent">Naithorn Bakery</div>
          <div style={{ display:'flex', alignItems:'center', gap:'0.4rem', marginTop:'1px' }}>
            <div className={`dot dot-green${liveIndicator?' dot-pulse':''}`} style={{ width:'6px', height:'6px' }} />
            <div className="view-sub">Live · {new Date().toLocaleDateString('en-KE',{weekday:'short',day:'numeric',month:'short'})}</div>
          </div>
        </div>
        <button onClick={logout} className="btn btn-ghost btn-sm">Sign out</button>
      </div>

      <div className="tab-bar">
        {[['overview','Overview'],['inventory','Inventory'],['workers','Workers'],['sales','All Sales']].map(([v,l]) => (
          <button key={v} className={`tab-btn ${tab===v?'active':''}`} onClick={() => setTab(v)}>{l}</button>
        ))}
      </div>

      <div className="view-body">
        {loading && <div className="empty">Loading live data...</div>}

        {!loading && (
          <>
            {/* ── OVERVIEW ── */}
            {tab === 'overview' && (
              <>
                {/* Revenue hero */}
                <div style={{ background:'var(--bg2)', borderRadius:'var(--radius)', padding:'1.1rem', border:'1px solid var(--border)', marginBottom:'0.875rem', display:'flex', justifyContent:'space-between', alignItems:'flex-end' }}>
                  <div>
                    <div style={{ fontSize:'0.68rem', color:'var(--text2)', textTransform:'uppercase', letterSpacing:'0.09em' }}>Revenue today</div>
                    <div style={{ fontSize:'2rem', fontWeight:'800', color:'var(--admin)', letterSpacing:'-0.03em', lineHeight:1.1 }}>
                      KES {todayRevenue.toLocaleString()}
                    </div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:'0.68rem', color:'var(--text2)', textTransform:'uppercase', letterSpacing:'0.09em' }}>Transactions</div>
                    <div style={{ fontSize:'1.5rem', fontWeight:'700', lineHeight:1.1 }}>{d.sales.length}</div>
                  </div>
                </div>

                <div className="stats-grid">
                  <div className="stat">
                    <div className="stat-val">{todayCakes.toLocaleString()}</div>
                    <div className="stat-lbl">Cakes baked</div>
                  </div>
                  <div className="stat">
                    <div className="stat-val">{todayCrates}</div>
                    <div className="stat-lbl">Crates packed</div>
                  </div>
                </div>

                {/* Hourly chart */}
                {hourly.some(h => h.revenue > 0) && (
                  <div className="card">
                    <div className="card-title">Sales per hour (KES)</div>
                    <ResponsiveContainer width="100%" height={130}>
                      <AreaChart data={hourly} margin={{ top:5, right:0, left:-28, bottom:0 }}>
                        <defs>
                          <linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="10%" stopColor="#a78bfa" stopOpacity={0.35}/>
                            <stop offset="90%" stopColor="#a78bfa" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="hour" tick={{ fill:'#64748b', fontSize:9 }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fill:'#64748b', fontSize:9 }} tickLine={false} axisLine={false} tickFormatter={v => v >= 1000 ? `${v/1000}k` : v} />
                        <Tooltip content={<ChartTip />} />
                        <Area type="monotone" dataKey="revenue" stroke="#a78bfa" strokeWidth={2} fill="url(#ag)" dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Product performance */}
                {prodList.length > 0 && (
                  <div className="card">
                    <div className="card-title">Products today</div>
                    {prodList.map(([name, stats], idx) => (
                      <div key={name} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'0.45rem 0', borderBottom: idx < prodList.length-1 ? '1px solid var(--border)' : 'none' }}>
                        <div>
                          <div style={{ fontSize:'0.875rem', fontWeight:'500' }}>{name}</div>
                          <div style={{ fontSize:'0.7rem', color:'var(--text2)' }}>{stats.cakes} cakes sold</div>
                        </div>
                        <div style={{ textAlign:'right' }}>
                          <div style={{ fontWeight:'700', color:'var(--admin)', fontSize:'0.9rem' }}>KES {stats.revenue.toLocaleString()}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Flour status */}
                <div className="card">
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'0.5rem' }}>
                    <div className="card-title" style={{ margin:0 }}>Flour stock</div>
                    <button onClick={() => setShowFlourEdit(!showFlourEdit)}
                      style={{ background:'none', border:'none', color:'var(--admin)', cursor:'pointer', fontSize:'0.8rem', fontWeight:'600' }}>
                      Update
                    </button>
                  </div>
                  {d.flour ? (
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end' }}>
                      <div>
                        <div style={{ fontSize:'1.6rem', fontWeight:'800', color: flourKg < 50 ? 'var(--danger)' : 'var(--text)', letterSpacing:'-0.02em' }}>
                          {flourKg.toFixed(1)} kg
                        </div>
                        {flourDays !== null && (
                          <div style={{ fontSize:'0.78rem', color: flourDays <= 3 ? 'var(--danger)' : 'var(--text2)', marginTop:'2px' }}>
                            {flourDays <= 3 ? '⚠ ' : ''}~{flourDays} day{flourDays !== 1 ? 's' : ''} remaining
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign:'right', fontSize:'0.72rem', color:'var(--text2)' }}>
                        Used today: {flourUsedToday.toFixed(1)}kg
                      </div>
                    </div>
                  ) : (
                    <div style={{ color:'var(--text2)', fontSize:'0.85rem' }}>No flour record yet</div>
                  )}
                  {showFlourEdit && (
                    <div style={{ display:'flex', gap:'0.5rem', marginTop:'0.75rem' }}>
                      <input type="number" placeholder="Enter kg" value={flourInput}
                        onChange={e => setFlourInput(e.target.value)} style={{ flex:1 }} />
                      <button className="btn btn-primary btn-sm" onClick={saveFlour}>Save</button>
                    </div>
                  )}
                </div>

                {/* Live delivery trackers */}
                {liveDeliveries.length > 0 && (
                  <div className="card">
                    <div className="card-title">🚚 Live deliveries</div>
                    {liveDeliveries.map(dv => {
                      const secs = dv.departed_at ? Math.floor((Date.now() - new Date(dv.departed_at).getTime())/1000) : 0
                      const hh   = String(Math.floor(secs/3600)).padStart(2,'0')
                      const mm   = String(Math.floor((secs%3600)/60)).padStart(2,'0')
                      return (
                        <div key={dv.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'0.45rem 0', borderBottom:'1px solid var(--border)' }}>
                          <div style={{ display:'flex', gap:'0.5rem', alignItems:'center' }}>
                            <div className="dot dot-pulse" style={{ background: STATUS_DOT[dv.status] }} />
                            <div>
                              <div style={{ fontSize:'0.875rem', fontWeight:'500' }}>{dv.driver?.name}</div>
                              <div style={{ fontSize:'0.72rem', color:'var(--text2)' }}>{dv.crates_taken} crates · {dv.status}</div>
                            </div>
                          </div>
                          {dv.departed_at && (
                            <div className="monospace" style={{ fontSize:'0.9rem', fontWeight:'700', color:'var(--delivery)' }}>
                              {hh}:{mm}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}

            {/* ── INVENTORY ── */}
            {tab === 'inventory' && (
              <>
                <div className="stats-grid">
                  <div className="stat"><div className="stat-val text-success">{totalStoreCrates}</div><div className="stat-lbl">In store</div></div>
                  <div className="stat"><div className="stat-val" style={{color:'var(--delivery)'}}>{totalTransit}</div><div className="stat-lbl">In transit</div></div>
                  <div className="stat"><div className="stat-val" style={{color:'var(--sales)'}}>{totalMarket}</div><div className="stat-lbl">At market</div></div>
                  <div className="stat"><div className="stat-val">{totalStoreCrates+totalTransit+totalMarket}</div><div className="stat-lbl">Total crates</div></div>
                </div>

                <div className="section-head">Per product breakdown</div>
                {d.inventory.map(inv => (
                  <div key={inv.id} className="card">
                    <div style={{ fontWeight:'700', marginBottom:'0.75rem' }}>{inv.product?.name}</div>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'0.5rem', textAlign:'center', marginBottom:'0.6rem' }}>
                      {[['Store', inv.store_crates||0, '#10b981'], ['Transit', inv.transit_crates||0, '#38bdf8'], ['Market', inv.market_crates||0, '#f59e0b']].map(([lbl,val,col]) => (
                        <div key={lbl} style={{ background:'var(--bg3)', borderRadius:'8px', padding:'0.6rem 0.4rem' }}>
                          <div style={{ fontSize:'1.3rem', fontWeight:'700', color:col }}>{val}</div>
                          <div style={{ fontSize:'0.65rem', color:'var(--text2)', marginTop:'2px' }}>{lbl}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize:'0.75rem', color:'var(--text2)' }}>
                      Total {((inv.store_crates||0)+(inv.transit_crates||0)+(inv.market_crates||0))} crates ·{' '}
                      {(((inv.market_crates||0)) * (inv.product?.cakes_per_crate||30)).toLocaleString()} cakes at market ·{' '}
                      KES {(((inv.market_crates||0)) * (inv.product?.cakes_per_crate||30) * RETAIL).toLocaleString()} value
                    </div>
                  </div>
                ))}

                <div className="section-head">Production today</div>
                {d.production.length === 0 && <div className="empty">No production logged today</div>}
                {d.production.map(log => (
                  <div key={log.id} className="list-item">
                    <div className="dot dot-green" />
                    <div style={{ flex:1 }}>
                      <div className="list-item-title">{log.worker?.name} — {log.product?.name}</div>
                      <div className="list-item-sub">
                        {log.mixes} mixes · {log.cakes_produced.toLocaleString()} cakes · {log.full_crates} crates · {parseFloat(log.flour_used_kg).toFixed(1)}kg flour
                        &nbsp;· {new Date(log.created_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}
                      </div>
                    </div>
                  </div>
                ))}

                <div className="section-head">Deliveries today</div>
                {d.deliveries.length === 0 && <div className="empty">No deliveries today</div>}
                {d.deliveries.map(dv => (
                  <div key={dv.id} className="list-item">
                    <div className="dot" style={{ background: STATUS_DOT[dv.status] }} />
                    <div style={{ flex:1 }}>
                      <div className="list-item-title">{dv.driver?.name} · {dv.crates_taken} crates</div>
                      <div className="list-item-sub">
                        {dv.departed_at ? `Dep ${new Date(dv.departed_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}` : 'Not departed'}
                        {dv.arrived_at  ? ` · Arr ${new Date(dv.arrived_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}` : ''}
                        {dv.broken_cakes > 0 ? ` · ⚠ ${dv.broken_cakes} broken` : ''}
                        {dv.empty_crates_returned > 0 ? ` · ${dv.empty_crates_returned} crates back` : ''}
                      </div>
                    </div>
                    <span className="badge" style={{ background:`${STATUS_DOT[dv.status]}18`, color: STATUS_DOT[dv.status], flexShrink:0 }}>{dv.status}</span>
                  </div>
                ))}
              </>
            )}

            {/* ── WORKERS ── */}
            {tab === 'workers' && (
              <>
                <div className="section-head">Today's attendance</div>
                {d.attendance.length === 0 && <div className="empty">No logins recorded today</div>}
                {d.attendance.map(att => (
                  <div key={att.id} className="list-item">
                    <div style={{
                      width:'38px', height:'38px', borderRadius:'50%', flexShrink:0,
                      background:`${ROLE_COLOR[att.profile?.role]||'#64748b'}18`,
                      display:'flex', alignItems:'center', justifyContent:'center',
                      fontWeight:'700', fontSize:'0.9rem',
                      color: ROLE_COLOR[att.profile?.role] || '#64748b',
                    }}>
                      {(att.profile?.name||'?').charAt(0)}
                    </div>
                    <div style={{ flex:1 }}>
                      <div className="list-item-title">{att.profile?.name}</div>
                      <div className="list-item-sub">
                        {new Date(att.login_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}
                        {att.logout_at
                          ? ` → ${new Date(att.logout_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}`
                          : ' → now'}
                      </div>
                    </div>
                    <div style={{ textAlign:'right', flexShrink:0 }}>
                      <div style={{ fontWeight:'700', fontSize:'0.9rem' }}>{duration(att)}</div>
                      {!att.logout_at && <div className="dot dot-green dot-pulse" style={{ margin:'3px auto 0' }} />}
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* ── ALL SALES ── */}
            {tab === 'sales' && (
              <>
                <div style={{ display:'flex', justifyContent:'space-between', padding:'0.5rem 0', marginBottom:'0.5rem', borderBottom:'1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize:'0.68rem', color:'var(--text2)', textTransform:'uppercase', letterSpacing:'0.08em' }}>Total revenue</div>
                    <div style={{ fontSize:'1.6rem', fontWeight:'800', color:'var(--admin)', letterSpacing:'-0.02em' }}>KES {todayRevenue.toLocaleString()}</div>
                  </div>
                  <div style={{ textAlign:'right' }}>
                    <div style={{ fontSize:'0.68rem', color:'var(--text2)', textTransform:'uppercase', letterSpacing:'0.08em' }}>Transactions</div>
                    <div style={{ fontSize:'1.6rem', fontWeight:'800' }}>{d.sales.length}</div>
                  </div>
                </div>

                {d.sales.length === 0 && <div className="empty">No sales today</div>}
                {d.sales.map(s => (
                  <div key={s.id} className="list-item">
                    <div style={{ flex:1, minWidth:0 }}>
                      <div className="list-item-title">{s.customer?.name}</div>
                      <div className="list-item-sub">
                        {s.cakes_sold} × {s.product?.name} · KES {parseFloat(s.unit_price)} {s.price_type}
                        &nbsp;· by {s.sp?.name}
                        &nbsp;· {new Date(s.created_at).toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'})}
                      </div>
                    </div>
                    <div style={{ fontWeight:'800', color:'var(--success)', fontSize:'0.9rem', flexShrink:0 }}>
                      +{parseFloat(s.total_amount).toLocaleString()}
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
