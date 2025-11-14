/**
 * bot.js
 * Bot WhatsApp com Baileys — fluxos step-by-step:
 * 1) Liberação de serviços (OS ou OC)
 * 2) Finalização de serviços
 * 3) Atualização de orçamento
 *
 * Estrutura de saída:
 * - uploads/              -> imagens recebidas
 * - userState.json        -> estado em andamento por usuário
 * - tickets.json          -> registros salvos (OS/OC/FINALIZACAO/ATUALIZACAO)
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadContentFromMessage
} from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"
import fs from "fs"
import path from "path"

const STATE_FILE = "userState.json"
const TICKETS_FILE = "tickets.json"
const UPLOADS_DIR = "uploads"

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR)

let userState = {}

// ================================
// CONFIGURAÇÃO DO NOTION
// ================================
import { Client } from "@notionhq/client"
import dotenv from "dotenv"
dotenv.config()

const notion = new Client({ auth: process.env.NOTION_TOKEN })
const databaseId = process.env.NOTION_DATABASE_ID

export async function createNotionPage(ticket) {
  try {
    const idNumber = Number(ticket.id.replace(/\D/g, "")) || 0

    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        PLACA: { title: [{ text: { content: ticket.placa || "Sem Placa" } }] },
        ID: { number: idNumber },
        tipo: { select: { name: ticket.type || "FINALIZACAO" } },
        INFORME: { rich_text: [{ text: { content: ticket.informe || "" } }] },
        "KM/HORIM": { number: Number(ticket.km) || 0 },
        STATUS: { status: { name: "Não iniciado" } },
        FINALIZADO: { checkbox: false },
      },
    })

    console.log(`✅ Ticket ${ticket.id} criado no Notion!`)
  } catch (error) {
    console.error("❌ Erro ao criar página no Notion:", error.body || error)
  }
}

// carrega estado salvo
if (fs.existsSync(STATE_FILE)) {
  try {
    userState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    console.log("📁 userState carregado.")
  } catch (e) {
    console.warn("⚠️ Não foi possível carregar userState:", e)
    userState = {}
  }
}

// util: salva estado
function saveUserState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(userState, null, 2))
  } catch (e) {
    console.error("Erro ao salvar userState:", e)
  }
}

// util: salva ticket
function saveTicket(ticket) {
  let arr = []
  try {
    if (fs.existsSync(TICKETS_FILE)) arr = JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"))
  } catch (e) {
    console.error("Erro lendo tickets:", e)
  }
  arr.push(ticket)
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(arr, null, 2))
}

// util: gera ID único
function genId(prefix) {
  const now = new Date()
  const date = now.toISOString().slice(2,10).replace(/-/g, "")
  const rnd = Math.floor(1000 + Math.random() * 9000)
  return `${prefix}${date}-${rnd}`
}


// texto menu
function menuText() {
  return `👋 *Menu Principal*

1️⃣ Liberação de serviços (OS ou OC)
2️⃣ Finalização de serviços
3️⃣ Atualização de orçamento

Digite o número da opção desejada.`
}

// mensagens gerais de fluxo
function fluxoLiberacaoIntro() {
  return `🏷️ *Liberação de serviços*\n\nDigite *OS* para abrir uma Ordem de Serviço ou *OC* para Ordem de Compra.`
}

function fluxoFinalizacaoIntro() {
  return `🧰 *Finalização de serviços*\n\nVamos registrar a finalização. Para começar, envie a *placa* do veículo.`
}

function fluxoAtualizacaoIntro() {
  return `💰 *Atualização de orçamento*\n\nVamos registrar uma atualização de orçamento. Envie a *placa* do veículo para começar.`
}

// função principal
async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info")
    const sock = makeWASocket({ auth: state })

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update
      if (qr) qrcode.generate(qr, { small: true })

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode
        if (reason !== DisconnectReason.loggedOut) {
          console.log("🔁 Conexão fechada — tentando reconectar...")
          startBot()
        } else {
          console.log("❌ Sessão encerrada (logged out). Escaneie o QR novamente.")
        }
      } else if (connection === "open") {
        console.log("✅ Conectado")
      }
    })

    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe) return

        const sender = msg.key.remoteJid
        // pegar texto (vários formatos)
        const text =
          msg.message.conversation?.trim() ||
          msg.message.extendedTextMessage?.text?.trim() ||
          msg.message?.buttonsResponseMessage?.selectedButtonId?.trim() ||
          ""

        const textLower = (text || "").toString().toLowerCase()

        // inicializa estado do usuário se não existente
        if (!userState[sender]) userState[sender] = { stage: null }

        // atalhos: voltar/menu/0
        if (["voltar", "menu", "0"].includes(textLower)) {
          userState[sender] = { stage: "menu" }
          saveUserState()
          await sock.sendMessage(sender, { text: menuText() })
          return
        }

        // se o usuário escreveu oi/olá -> mostrar menu
        if (/^(oi|olá|ola|bom dia|boa tarde|boa noite)$/i.test(text)) {
          userState[sender] = { stage: "menu" }
          saveUserState()
          await sock.sendMessage(sender, { text: menuText() })
          return
        }

        const user = userState[sender]

        // ------------------------------
        // MENU PRINCIPAL
        // ------------------------------
        if (user.stage === "menu" || user.stage === null) {
          switch (textLower) {
            case "1":
              userState[sender] = { stage: "liberacao", step: 0, data: {} }
              saveUserState()
              await sock.sendMessage(sender, { text: fluxoLiberacaoIntro() })
              return

            case "2":
              userState[sender] = { stage: "finalizacao", step: 1, data: {} }
              saveUserState()
              await sock.sendMessage(sender, { text: fluxoFinalizacaoIntro() })
              return

            case "3":
              userState[sender] = { stage: "atualizacao", step: 1, data: {} }
              saveUserState()
              await sock.sendMessage(sender, { text: fluxoAtualizacaoIntro() })
              return

            default:
              await sock.sendMessage(sender, { text: "❓ Opção inválida. Digite 1, 2 ou 3." })
              return
          }
        }

        // ------------------------------
// FLUXO 1 — LIBERAÇÃO (OS ou OC)
// ------------------------------
if (user.stage === "liberacao") {
  // step 0: escolha OS ou OC
  if (user.step === 0) {
    if (!text) {
      await sock.sendMessage(sender, { text: "Digite *OS* ou *OC* para continuar." })
      return
    }
    const escolha = textLower
    if (escolha === "os" || escolha === "oc") {
      user.data.type = escolha === "os" ? "OS" : "OC"
      user.step = 1
      userState[sender] = user
      saveUserState()

      // mensagem inicial específica
      if (user.data.type === "OS") {
        await sock.sendMessage(sender, { text: "🧾 *OS* — Envie o nome do *contrato*:" })
      } else {
        await sock.sendMessage(sender, { text: "🧾 *OC* — Envie o nome do *contrato*:" })
      }
      return
    } else {
      await sock.sendMessage(sender, { text: "Resposta inválida. Digite *OS* ou *OC*." })
      return
    }
  }

  // step 1: contrato
  if (user.step === 1) {
    if (!text || text.length < 2) {
      await sock.sendMessage(sender, { text: "❌ Contrato inválido. Envie o nome do contrato:" })
      return
    }
    user.data.contrato = text
    user.step = 2
    userState[sender] = user
    saveUserState()

    if (user.data.type === "OS") {
      await sock.sendMessage(sender, { text: "🚗 Envie a *placa* do veículo:" })
    } else {
      await sock.sendMessage(sender, { text: "🚗 Envie a *placa ou matrícula*:" })
    }
    return
  }

  // step 2: placa
  if (user.step === 2) {
    if (!text || text.length < 2) {
      await sock.sendMessage(sender, { text: "❌ Placa inválida. Envie novamente:" })
      return
    }
    user.data.placa = text.toUpperCase()
    user.step = 3
    userState[sender] = user
    saveUserState()

    if (user.data.type === "OS") {
      await sock.sendMessage(sender, { text: "📸 Envie *fotos do serviço* (Foto frontal + KM/Horímetro). Digite *ok* quando terminar." })
    } else {
      await sock.sendMessage(sender, { text: "📸 Envie *evidências do serviço*. Quando terminar, digite *ok*." })
    }
    return
  }

  // step 3: fotos
  if (user.step === 3) {
    if (msg.message?.imageMessage) {
      try {
        const stream = await downloadContentFromMessage(msg.message.imageMessage, "image")
        const buffer = []
        for await (const chunk of stream) buffer.push(chunk)
        const ticketId = user.data.ticketId || genId(user.data.type || "LIB")
        const filename = path.join(UPLOADS_DIR, `${ticketId}_${Date.now()}.jpg`)
        fs.writeFileSync(filename, Buffer.concat(buffer))
        user.data.ticketId = ticketId
        user.data.images = user.data.images || []
        user.data.images.push(filename)
        userState[sender] = user
        saveUserState()
        await sock.sendMessage(sender, { text: "📸 Foto recebida. Envie mais fotos ou digite *ok* para continuar." })
        return
      } catch (e) {
        console.error("Erro salvando imagem:", e)
        await sock.sendMessage(sender, { text: "Erro ao salvar imagem. Tente novamente." })
        return
      }
    }

    if (textLower === "ok") {
      user.step = 4
      userState[sender] = user
      saveUserState()
      await sock.sendMessage(sender, { text: "📏 Envie o *KM / Horímetro* atual:" })
      return
    }

    await sock.sendMessage(sender, { text: "Envie uma imagem ou digite *ok* para continuar." })
    return
  }

  // step 4: KM / Horímetro
  if (user.step === 4) {
    if (!text || isNaN(Number(text.replace(",", ".")))) {
      await sock.sendMessage(sender, { text: "⚠️ Envie apenas números para o KM / Horímetro (ex: 12345):" })
      return
    }
    user.data.km = text
    user.step = 5
    userState[sender] = user
    saveUserState()

    await sock.sendMessage(sender, { text: "🧾 Envie um *breve informe técnico* (motivo, avaria ou não):" })
    return
  }

  // step 5: informe técnico (OS ou OC)
  if (user.step === 5) {
    if (!text || text.length < 3) {
      await sock.sendMessage(sender, { text: "❌ Informe técnico muito curto. Descreva um pouco mais:" })
      return
    }
    user.data.informe = text

    if (user.data.type === "OC") {
      user.step = 6
      userState[sender] = user
      saveUserState()
      await sock.sendMessage(sender, { 
  text: `💵 Agora envie o *orçamento* com as seguintes informações:\n\n` +
        `• 🏢 *Nome da empresa ou prestador*\n` +
        `• 🪪 *CNPJ*\n` +
        `• 💳 *Forma de pagamento*\n` +
        `• ⏱️ *Prazo de execução*\n\n` +
        `Se for *transferência*, informe também os *dados bancários completos*:\n` +
        `• 🏦 Banco\n` +
        `• 🏛️ Agência\n` +
        `• 💰 Conta\n` +
        `• 👤 Titularidade`
})
return
    }

    const ticketId = user.data.ticketId || genId("OS")
    const resumo =
      `📋 *Resumo da Solicitação (OS)*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 ID: ${ticketId}\n` +
      `📄 Contrato: ${user.data.contrato}\n` +
      `🚗 Placa: ${user.data.placa}\n` +
      `📏 KM/Horímetro: ${user.data.km}\n` +
      `🧾 Informe Técnico: ${user.data.informe}\n` +
      `📸 Fotos: ${user.data.images?.length || 0} anexada(s)\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ Tudo certo? Enviando...`

    await sock.sendMessage(sender, { text: resumo })

    const ticket = {
      id: ticketId,
      type: "OS",
      contrato: user.data.contrato,
      placa: user.data.placa,
      km: user.data.km || null,
      images: user.data.images || [],
      informe: user.data.informe,
      createdAt: new Date().toISOString()
    }

    saveTicket(ticket)
    await createNotionPage(ticket)
    await sock.sendMessage(sender, { 
      text: `✅ Informações salvas com sucesso!\nID: ${ticket.id}\n⚠️ OBS: Este número é apenas de atendimento.\nDigite *menu* para voltar ao menu principal.`
    })
    delete userState[sender]
    saveUserState()
    return
  }

  // step 6: orçamento (somente OC)
  if (user.step === 6) {
    if (!text || text.length < 10) {
      await sock.sendMessage(sender, { text: "❌ Orçamento inválido. Envie os dados do orçamento (nome, CNPJ, forma de pagamento, prazo) ou anexe um arquivo." })
      return
    }
    user.data.orcamento = text

    const ticketId = user.data.ticketId || genId("OC")
    const resumo =
      `📋 *Resumo da Solicitação (OC)*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 ID: ${ticketId}\n` +
      `📄 Contrato: ${user.data.contrato}\n` +
      `🚗 Placa: ${user.data.placa}\n` +
      `📏 KM/Horímetro: ${user.data.KM/HORIM}\n` +
      `🧾 Informe Técnico: ${user.data.informe}\n` +
      `💵 Orçamento: ${user.data.orcamento}\n` +
      `📸 Fotos: ${user.data.images?.length || 0} anexada(s)\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ Tudo certo? Enviando...`

    await sock.sendMessage(sender, { text: resumo })

    const ticket = {
      id: ticketId,
      type: "OC",
      contrato: user.data.contrato,
      placa: user.data.placa,
      km: user.data.km || null,
      images: user.data.images || [],
      informe: user.data.informe,
      orcamento: user.data.orcamento,
      createdAt: new Date().toISOString()
    }

    saveTicket(ticket)
    await createNotionPage(ticket)
    await sock.sendMessage(sender, { 
      text: `✅ Informações salvas!\nID: ${ticket.id}\n⚠️OBS: Este número é apenas de atendimento. \nDigite *menu* para voltar ao menu principal.`
    })
    delete userState[sender]
    saveUserState()
    return
  }
}

// ------------------------------
// FLUXO 2 — FINALIZAÇÃO DE SERVIÇOS
// ------------------------------
if (user.stage === "finalizacao") {
  if (user.step === 1) {
    if (!text || text.length < 2) {
      await sock.sendMessage(sender, { text: "❌ Placa inválida. Envie a placa do veículo:" })
      return
    }
    user.data.placa = text.toUpperCase()
    user.step = 2
    userState[sender] = user
    saveUserState()
    await sock.sendMessage(sender, { text: "🧾 Envie o número do *ID*de atendimento,  *OS* ou *OC* que será finalizada:" })
    return
  }

  if (user.step === 2) {
    user.data.osNumber = text
    user.step = 3
    userState[sender] = user
    saveUserState()
    await sock.sendMessage(sender, { text: "📸 Envie fotos dos serviços realizados. Quando terminar, digite *ok*." })
    return
  }

  if (user.step === 3) {
    if (msg.message?.imageMessage) {
      try {
        const stream = await downloadContentFromMessage(msg.message.imageMessage, "image")
        const buffer = []
        for await (const chunk of stream) buffer.push(chunk)
        const ticketId = user.data.ticketId || genId("FINAL")
        const filename = path.join(UPLOADS_DIR, `${ticketId}_${Date.now()}.jpg`)
        fs.writeFileSync(filename, Buffer.concat(buffer))
        user.data.ticketId = ticketId
        user.data.images = user.data.images || []
        user.data.images.push(filename)
        userState[sender] = user
        saveUserState()
        await sock.sendMessage(sender, { text: "📸 Foto recebida. Envie mais fotos ou digite *ok* para continuar." })
        return
      } catch (e) {
        console.error("Erro salvando imagem:", e)
        await sock.sendMessage(sender, { text: "Erro ao salvar imagem. Tente novamente." })
        return
      }
    }

    if (textLower === "ok") {
      user.step = 4
      userState[sender] = user
      saveUserState()
      await sock.sendMessage(sender, { text: "🧾 Envie um breve informe do que foi feito e o que ficou pendente (se houver):" })
      return
    }

    await sock.sendMessage(sender, { text: "Envie uma imagem ou digite *ok* para continuar." })
    return
  }

  if (user.step === 4) {
  if (!text || text.length < 3) {
    await sock.sendMessage(sender, { text: "❌ Informe muito curto. Descreva o serviço realizado:" })
    return
  }

  user.data.informe = text
  const ticketId = user.data.ticketId || genId("FINAL")

  const resumo =
    `📋 *Resumo da Finalização*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: ${ticketId}\n` +
    `🚗 Placa: ${user.data.placa}\n` +
    `📄 OS/OC: ${user.data.osNumber || "Não informado"}\n` +
    `🧾 Informe Final: ${user.data.informe}\n` +
    `📸 Fotos: ${user.data.images?.length || 0} anexada(s)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Tudo certo? Enviando...`

  await sock.sendMessage(sender, { text: resumo })

  const ticket = {
    id: ticketId,
    type: "FINALIZACAO",
    placa: user.data.placa,
    osNumber: user.data.osNumber,
    images: user.data.images || [],
    informe: user.data.informe,
    createdAt: new Date().toISOString()
  }

  saveTicket(ticket)

  // ✅ Cria nova página no Notion (não tenta atualizar)
  await createNotionPage(ticket)
  await sock.sendMessage(sender, { 
    text: `✅ Finalização registrada no Notion!\nID: ${ticket.id}\nDigite *menu* para voltar ao menu principal.` 
  })

  delete userState[sender]
  saveUserState()
  return
}
}  

      // ------------------------------
      // FLUXO 3 — ATUALIZAÇÃO DE ORÇAMENTO
      // ------------------------------
      if (user.stage === "atualizacao") {
        // Passo 1: pedir placa
        if (user.step === 1) {
          if (!text || text.length < 2) {
            await sock.sendMessage(sender, { text: "❌ Placa inválida. Envie a placa do veículo:" });
            return;
          }

          user.data.placa = text.toUpperCase();
          user.step = 2;
          userState[sender] = user;
          saveUserState();

          await sock.sendMessage(sender, { text: "🧾 Envie o número da *ordem de compra* ou *ordem de serviço*:" });
          return;
        }

        // Passo 2: número da OS/OC
        if (user.step === 2) {
          user.data.orderNumber = text;
          user.step = 3;
          userState[sender] = user;
          saveUserState();

          await sock.sendMessage(sender, {
            text: "📸 Envie fotos dos serviços executados (pelo menos 1). Quando terminar, digite *ok*."
          });
          return;
        }

        // Passo 3: fotos
        if (user.step === 3) {
          if (msg.message?.imageMessage) {
            try {
              const stream = await downloadContentFromMessage(msg.message.imageMessage, "image");
              const buffer = [];
              for await (const chunk of stream) buffer.push(chunk);

              const ticketId = user.data.ticketId || genId("ATU");
              const filename = path.join(UPLOADS_DIR, `${ticketId}_${Date.now()}.jpg`);

              fs.writeFileSync(filename, Buffer.concat(buffer));

              user.data.ticketId = ticketId;
              user.data.images = user.data.images || [];
              user.data.images.push(filename);

              userState[sender] = user;
              saveUserState();

              await sock.sendMessage(sender, { text: "📸 Foto recebida. Envie mais fotos ou digite *ok* para continuar." });
              return;
            } catch (e) {
              console.error("Erro salvando imagem:", e);
              await sock.sendMessage(sender, { text: "⚠ Erro ao salvar imagem. Tente novamente." });
              return;
            }
          }

          if (textLower === "ok") {
            user.step = 4;
            userState[sender] = user;
            saveUserState();

            await sock.sendMessage(sender, { text: "🧾 Envie um breve informe do *motivo do aumento do orçamento*:" });
            return;
          }

          await sock.sendMessage(sender, { text: "Envie uma imagem ou digite *ok* para continuar." });
          return;
        }

        // Passo 4: motivo
        if (user.step === 4) {
          if (!text || text.length < 3) {
            await sock.sendMessage(sender, { text: "❌ Informe muito curto. Especifique melhor o motivo do aumento:" });
            return;
          }

          user.data.motivo = text;
          user.step = 5;
          userState[sender] = user;
          saveUserState();

          await sock.sendMessage(sender, { text: "💵 Envie o *valor adicional* (apenas números, ex: 1234.56):" });
          return;
        }

        // Passo 5: valor adicional
        if (user.step === 5) {
          const valor = Number(text.replace(",", "."));
          if (!text || isNaN(valor)) {
            await sock.sendMessage(sender, { text: "⚠ Valor inválido. Envie apenas números (ex: 1234.56):" });
            return;
          }

          user.data.valorAdicional = valor;

          const ticket = {
            id: user.data.ticketId || genId("ATU"),
            type: "ATUALIZACAO",
            placa: user.data.placa,
            orderNumber: user.data.orderNumber,
            images: user.data.images || [],
            motivo: user.data.informe,
            valorAdicional: user.data.valorAdicional,
            createdAt: new Date().toISOString()
          };

          saveTicket(ticket);
          await createNotionPage(ticket);

          await sock.sendMessage(sender, {
            text: `✅ Informações salvas com sucesso!\n🆔 ID: ${ticket.id}\nDigite *menu* para voltar ao menu principal.`
          });

          delete userState[sender];
          saveUserState();
          return;
        }
      }

      // -------mensagem padrão----------//
      if (!user || !user.stage) {
        await sock.sendMessage(sender, {
          text: "👋 Digite *oi* para iniciar o atendimento ou *menu* para ver as opções."
        });
      }
    } catch (err) {
      console.error("Erro ao processar mensagem:", err);
    }
  });

  sock.ev.on("creds.update", saveCreds);
} catch (e) {
  console.error("Erro ao iniciar bot:", e);
  setTimeout(startBot, 5000);
}
}

startBot();
