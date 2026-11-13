import { computed, reactive, ref } from 'vue'
import { Client } from '@stomp/stompjs'
import SockJS from 'sockjs-client'

export interface Telemetria {
  temperatura: number; humedadSuelo: number; humedadAire: number; luminosidad: number
  caloventorActivo: boolean; humidificadorActivo: boolean
  ventanalesAbiertos: boolean; persianasEnrolladas: boolean; bombaActiva: boolean
  esDeDia: boolean
}
export interface Alerta {
  id: number; tipo: string; codigo?: string; componente: string; mensaje: string; severidad: string; timestamp: string
}
export interface MuestraViva {
  t: number; temperatura: number; humedadSuelo: number; humedadAire: number; luminosidad: number
}

const INICIAL: Telemetria = {
  temperatura: 0, humedadSuelo: 0, humedadAire: 0, luminosidad: 0,
  caloventorActivo: false, humidificadorActivo: false,
  ventanalesAbiertos: false, persianasEnrolladas: false, bombaActiva: false,
  esDeDia: true
}

/** Máximo de notificaciones visibles de cada tipo de alerta (siempre las más recientes). */
export const MAX_ALERTAS_POR_TIPO = 2
const MAX_ALERTAS = 100           // tope de seguridad
const MAX_MUESTRAS = 200          // ~10 min con una muestra cada 3 s
const SIN_DATOS_MS = 10_000
const WS_URL = import.meta.env.VITE_WS_URL ?? 'http://localhost:8080/ws-invernadero'

// Estado compartido (una sola conexión para toda la aplicación)
const telemetria = reactive<Telemetria>({ ...INICIAL })
const alertas = ref<Alerta[]>([])           // ordenadas de la más reciente a la más antigua
const muestras = ref<MuestraViva[]>([])
const conectado = ref(false)
const ultimaMuestra = ref(0)
const ahora = ref(Date.now())

/** true si no hay conexión o no llega telemetría desde hace más de 10 s */
const sinDatos = computed(() => !conectado.value || ahora.value - ultimaMuestra.value > SIN_DATOS_MS)

let client: Client | null = null
let contador = 0

/** Identifica el tipo de una alerta: su código, o tipo+componente+severidad si no lo trae. */
const claveTipo = (a: Alerta) => a.codigo ?? `${a.tipo}|${a.componente}|${a.severidad}`

/** Agrega la alerta al principio y descarta las más antiguas de su tipo que excedan el máximo. */
function registrarAlerta(nueva: Alerta) {
  const porTipo = new Map<string, number>()
  alertas.value = [nueva, ...alertas.value]
    .filter(a => {
      const clave = claveTipo(a)
      const n = (porTipo.get(clave) ?? 0) + 1
      porTipo.set(clave, n)
      return n <= MAX_ALERTAS_POR_TIPO
    })
    .slice(0, MAX_ALERTAS)
}

export function conectar() {
  if (client) return
  setInterval(() => { ahora.value = Date.now() }, 1000)

  const c = new Client({
    webSocketFactory: () => new SockJS(WS_URL) as unknown as WebSocket,
    reconnectDelay: 5000,
    onConnect: () => {
      conectado.value = true
      c.subscribe('/topic/sensores', m => {
        const d = JSON.parse(m.body) as Telemetria
        Object.assign(telemetria, d)
        ultimaMuestra.value = Date.now()
        muestras.value.push({
          t: ultimaMuestra.value,
          temperatura: d.temperatura, humedadSuelo: d.humedadSuelo,
          humedadAire: d.humedadAire, luminosidad: d.luminosidad
        })
        if (muestras.value.length > MAX_MUESTRAS) muestras.value.shift()
      })
      c.subscribe('/topic/alertas', m => {
        registrarAlerta({ ...JSON.parse(m.body), id: ++contador })
      })
    },
    onWebSocketClose: () => {
      conectado.value = false
      Object.assign(telemetria, INICIAL)
    },
    onStompError: f => console.error('STOMP:', f.headers['message'])
  })
  client = c
  c.activate()
}

export const useInvernadero = () => ({
  telemetria, alertas, muestras, conectado, sinDatos,
  descartarAlerta: (id: number) => { alertas.value = alertas.value.filter(a => a.id !== id) },
  limpiarAlertas: () => { alertas.value = [] }
})