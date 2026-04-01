import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import axios from 'axios'
import cron from 'node-cron'
import express from 'express'

// ─────────────────────────────────────────
// КОНФИГУРАЦИЯ
// ─────────────────────────────────────────

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const clickup = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: {
    Authorization: process.env.CLICKUP_API_TOKEN,
    'Content-Type': 'application/json'
  }
})

const TEAM_ID = process.env.CLICKUP_TEAM_ID
const LIST_ID = process.env.CLICKUP_LIST_ID
const PM_AGENT_USER_ID = process.env.PM_AGENT_USER_ID
const PORT = process.env.PORT || 3000

const PRIORITY_MAP = { critical: 1, high: 2, medium: 3, low: 4 }

// ─────────────────────────────────────────
// СИСТЕМНЫЙ ПРОМПТ PM-АГЕНТА
// ─────────────────────────────────────────

const PM_SYSTEM_PROMPT = `Ты PM-агент продукта SafeButton — мобильного приложения тревожной кнопки.

Стек: React Native + Expo, Supabase (PostgreSQL + Auth + Edge Functions + Realtime + Storage), Expo Push API, Twilio (SMS), Resend (Email), react-native-maps.

Когда получаешь PRD или описание фичи — декомпозируй на конкретные задачи.

Типичная структура задач для каждой фичи SafeButton:
1. Backend: SQL миграция + RLS политики (Supabase)
2. Backend: Edge Function (если нужна бизнес-логика)
3. Frontend: экраны React Native
4. Frontend: интеграция с Supabase (запросы, Realtime)
5. QA: написание тестов

ВАЖНО: Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown-блоков, без \`\`\`json.

Формат ответа:
{
  "epic_name": "Название эпика",
  "epic_description": "Что это за фича и зачем",
  "total_story_points": 21,
  "parallel_summary": "Что можно делать параллельно",
  "tasks": [
    {
      "name": "Название задачи",
      "description": "Детальное описание что нужно сделать",
      "role": "backend",
      "priority": "high",
      "story_points": 3,
      "estimated_days": 2,
      "depends_on_indexes": [],
      "parallel_with_indexes": [1],
      "subtasks": [
        { "name": "Название подзадачи", "description": "Детали" }
      ]
    }
  ]
}`

// ─────────────────────────────────────────
// CLICKUP API — ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ─────────────────────────────────────────

async function getTask(taskId) {
  const r = await clickup.get(`/task/${taskId}`)
  return r.data
}

async function getComments(taskId) {
  try {
    const r = await clickup.get(`/task/${taskId}/comment`)
    return r.data.comments ?? []
  } catch {
    return []
  }
}

async function addComment(taskId, text) {
  await clickup.post(`/task/${taskId}/comment`, {
    comment_text: text,
    notify_all: false
  })
  console.log(`💬 Комментарий добавлен в задачу ${taskId}`)
}

async function createTask(params) {
  const body = {
    name: params.name,
    description: params.description ?? '',
    priority: params.priority ?? 3,
    tags: params.tags ?? [],
  }

  if (params.due_date) {
    body.due_date = params.due_date
    body.due_date_time = false
  }

  console.log(`📤 POST /list/${LIST_ID}/task — ${body.name}`)
  const r = await clickup.post(`/list/${LIST_ID}/task`, body)
  return r.data
}

async function createSubtask(parentId, name, description) {
  try {
    const r = await clickup.post(`/list/${LIST_ID}/task`, {
      name,
      description: description ?? '',
      parent: parentId
    })
    console.log(`    📎 Subtask создана: ${name}`)
    return r.data
  } catch (e) {
    console.warn(`    ⚠️ Subtask пропущена (${name}): ${e.response?.status} ${JSON.stringify(e.response?.data ?? e.message)}`)
    return null
  }
}

async function addDependency(taskId, dependsOnId) {
  try {
    await clickup.post(`/task/${taskId}/dependency`, {
      depends_on: dependsOnId
    })
  } catch (e) {
    console.warn(`⚠️ Зависимость не создана: ${e.message}`)
  }
}

// ─────────────────────────────────────────
// ОСНОВНАЯ ЛОГИКА — ОБРАБОТКА PRD
// ─────────────────────────────────────────

async function getPRDContent(task) {
  const fullTask = await getTask(task.id ?? task.task_id)
  let content = `# ${fullTask.name}\n\n`

  if (fullTask.description) {
    content += fullTask.description + '\n\n'
  }

  // Добавить комментарии как дополнительный контекст
  const comments = await getComments(fullTask.id)
  const nonAgentComments = comments.filter(
    c => c.user?.id?.toString() !== PM_AGENT_USER_ID.toString()
  )

  if (nonAgentComments.length > 0) {
    content += '## Дополнительный контекст из комментариев\n'
    nonAgentComments.slice(0, 5).forEach(c => {
      content += `\n- ${c.comment_text}`
    })
  }

  return { content, taskId: fullTask.id }
}

async function decomposePRD(prdContent) {
  console.log('🧠 Claude анализирует PRD...')

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: PM_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prdContent }]
  })

  const text = response.content[0].text.trim()

  // Парсим JSON — убираем возможные markdown-блоки
  const cleaned = text.replace(/^```json\n?/m, '').replace(/\n?```$/m, '').trim()
  return JSON.parse(cleaned)
}

async function createTasksInClickUp(plan) {
  const createdIds = []

  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i]

    const dueDate = task.estimated_days
      ? Date.now() + task.estimated_days * 86400000
      : null

    const clickupTask = await createTask({
      name: task.name,
      description: buildDescription(task, i),
      priority: PRIORITY_MAP[task.priority] ?? 3,
      tags: [task.role],
      due_date: dueDate
    })

    createdIds.push(clickupTask.id)
    console.log(`  ✅ [${i + 1}/${plan.tasks.length}] ${task.name}`)

    // Создать подзадачи
    for (const sub of task.subtasks ?? []) {
      await createSubtask(clickupTask.id, sub.name, sub.description)
    }

    // Небольшая пауза чтобы не спамить API
    await sleep(300)
  }

  // Проставить зависимости
  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i]
    if (task.depends_on_indexes?.length > 0) {
      for (const depIdx of task.depends_on_indexes) {
        if (createdIds[depIdx]) {
          await addDependency(createdIds[i], createdIds[depIdx])
        }
      }
    }
  }

  return createdIds
}

function buildDescription(task, index) {
  const lines = [
    `## Описание`,
    task.description,
    ``,
    `## Роль исполнителя`,
    task.role,
    ``,
    `## Story Points: ${task.story_points}`,
    `## Оценка: ${task.estimated_days ?? '?'} дн.`,
  ]

  if (task.depends_on_indexes?.length > 0) {
    lines.push(`\n## Зависит от задач с индексами: ${task.depends_on_indexes.join(', ')}`)
  }

  if (task.parallel_with_indexes?.length > 0) {
    lines.push(`## Можно делать параллельно с задачами: ${task.parallel_with_indexes.join(', ')}`)
  }

  return lines.join('\n')
}

function buildSummaryComment(plan, createdIds) {
  const taskList = plan.tasks
    .map((t, i) => `${i + 1}. [${t.role.toUpperCase()}] ${t.name} — ${t.story_points} SP`)
    .join('\n')

  return `✅ PM-агент завершил декомпозицию PRD

📦 Создано задач: ${createdIds.length}
⚡ Суммарно: ${plan.total_story_points} story points

📋 Список задач:
${taskList}

🔀 Параллельность:
${plan.parallel_summary}

👉 Следующий шаг: тех-лид назначает задачи на разработчиков`
}

async function processPRD(task) {
  const taskId = task.id ?? task.task_id

  // Проверяем что задача из нужного списка — не трогаем чужие задачи
  if (task.list?.id && task.list.id !== LIST_ID) {
    console.log(`⏭️ Пропускаем задачу из другого списка: ${task.list.id}`)
    return
  }

  console.log(`\n🤖 PM-агент обрабатывает: ${task.name}`)

  try {
    await addComment(taskId,
      `🤖 PM-агент начал обработку PRD\n\nАнализирую требования и готовлю декомпозицию...`
    )

    const { content } = await getPRDContent(task)
    const plan = await decomposePRD(content)

    console.log(`📋 Декомпозировано: ${plan.tasks.length} задач, ${plan.total_story_points} SP`)

    const createdIds = await createTasksInClickUp(plan)
    await addComment(taskId, buildSummaryComment(plan, createdIds))

    console.log(`✅ PRD обработан успешно!`)

  } catch (error) {
    console.error('❌ Ошибка PM-агента:', error.message)
    await addComment(taskId,
      `❌ PM-агент: ошибка обработки\n\n${error.message}\n\nПроверьте PRD и попробуйте снова.`
    ).catch(() => {})
  }
}

// ─────────────────────────────────────────
// CRON — НАПОМИНАНИЯ О ДЕДЛАЙНАХ
// ─────────────────────────────────────────

async function checkDeadlines() {
  console.log(`\n⏰ [${new Date().toLocaleString('ru-RU')}] Проверка дедлайнов...`)

  try {
    const now = Date.now()

    const response = await clickup.get(`/team/${TEAM_ID}/task`, {
      params: {
        due_date_lt: now,
        include_closed: false,
        subtasks: false,
        page: 0,
        limit: 100
      }
    })

    const tasks = response.data.tasks ?? []
    const overdue = tasks.filter(t =>
      t.status?.status?.toLowerCase() !== 'complete' &&
      t.status?.status?.toLowerCase() !== 'closed' &&
      t.status?.status?.toLowerCase() !== 'cancelled' &&
      t.due_date
    )

    console.log(`📋 Просроченных задач: ${overdue.length}`)

    for (const task of overdue) {
      await handleOverdueTask(task, now)
      await sleep(200)
    }

  } catch (error) {
    console.error('Ошибка проверки дедлайнов:', error.message)
  }
}

async function handleOverdueTask(task, now) {
  const daysOverdue = Math.floor((now - Number(task.due_date)) / 86400000)
  if (daysOverdue < 1) return

  // Проверить — писали ли уже сегодня
  const comments = await getComments(task.id)
  const todayStr = new Date().toDateString()

  const alreadyCommented = comments.some(c => {
    const commentDate = new Date(Number(c.date)).toDateString()
    return (
      c.user?.id?.toString() === PM_AGENT_USER_ID.toString() &&
      commentDate === todayStr &&
      c.comment_text?.includes('просроч')
    )
  })

  if (alreadyCommented) return

  // Формируем текст напоминания
  let urgency = ''
  if (daysOverdue === 1) {
    urgency = `⚠️ Задача просрочена на 1 день`
  } else if (daysOverdue <= 3) {
    urgency = `⚠️ Задача просрочена на ${daysOverdue} дня`
  } else {
    urgency = `🚨 Задача просрочена на ${daysOverdue} дней — требует внимания!`
  }

  const assignees = task.assignees?.map(a => `@${a.username}`).join(', ') ?? ''
  const dueDate = new Date(Number(task.due_date)).toLocaleDateString('ru-RU')

  const message = [
    urgency,
    '',
    assignees ? `${assignees} — пожалуйста, обнови статус задачи или перенеси дедлайн.` : 'Пожалуйста, обнови статус задачи или перенеси дедлайн.',
    '',
    `📌 Задача: ${task.name}`,
    `📅 Дедлайн был: ${dueDate}`,
    `⏱ Просрочено: ${daysOverdue} дн.`,
    '',
    `_Автоматическое напоминание от PM-агента_`
  ].join('\n')

  await addComment(task.id, message)
  console.log(`  💬 Напоминание: "${task.name}" (${daysOverdue} дн.)`)
}

// ─────────────────────────────────────────
// WEBHOOK — ПОЛУЧАЕМ СОБЫТИЯ ОТ CLICKUP
// ─────────────────────────────────────────

const app = express()
app.use(express.json())

// Health check для Railway
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    agent: 'SafeButton PM-Agent',
    time: new Date().toISOString()
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Основной webhook от ClickUp
app.post('/webhook', async (req, res) => {
  // Быстро отвечаем чтобы ClickUp не таймаутился
  res.sendStatus(200)

  const event = req.body
  console.log(`\n📥 Webhook: ${event.event}`)

  try {
    // Триггер 1 — задача создана с тегом "prd" или "ready for pm agent"
    if (event.event === 'taskCreated') {
      const task = event.task ?? { id: event.task_id, name: 'New Task' }
      const tags = task.tags?.map(t => t.name?.toLowerCase()) ?? []

      if (tags.includes('prd') || tags.includes('ready for pm agent')) {
        await processPRD(task)
      }
    }

    // Триггер 2 — статус задачи изменён на "ready for pm agent"
    if (event.event === 'taskStatusUpdated') {
      const newStatus = event.task?.status?.status?.toLowerCase() ?? ''
      if (newStatus === 'ready for pm agent' || newStatus === 'ready for ai') {
        await processPRD(event.task)
      }
    }

    // Триггер 3 — комментарий с упоминанием PM-агента
    if (event.event === 'taskCommentPosted') {
      const commentText = event.comment?.comment_text?.toLowerCase() ?? ''
      if (
        commentText.includes('@pm-агент') ||
        commentText.includes('@pm-agent') ||
        commentText.includes('pm agent разбери') ||
        commentText.includes('pm agent декомпозируй')
      ) {
        const taskId = event.task_id
        const task = await getTask(taskId)
        await processPRD(task)
      }
    }

  } catch (error) {
    console.error('Ошибка обработки webhook:', error.message)
  }
})

// Ручной триггер — для тестирования
// POST /process с телом { "task_id": "..." }
app.post('/process', async (req, res) => {
  const { task_id } = req.body

  if (!task_id) {
    return res.status(400).json({ error: 'task_id обязателен' })
  }

  res.json({ status: 'started', task_id })

  try {
    const task = await getTask(task_id)
    await processPRD(task)
  } catch (error) {
    console.error('Ошибка ручного запуска:', error.message)
  }
})

// Ручная проверка дедлайнов — для тестирования
app.post('/check-deadlines', async (req, res) => {
  res.json({ status: 'started' })
  await checkDeadlines()
})

// ─────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ─────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─────────────────────────────────────────
// ЗАПУСК
// ─────────────────────────────────────────

// Cron: проверка дедлайнов каждый час в :00
cron.schedule('0 * * * *', () => {
  checkDeadlines().catch(console.error)
})

app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🤖 SafeButton PM-Agent запущен!')
  console.log(`📡 Порт: ${PORT}`)
  console.log(`👤 ClickUp User ID: ${PM_AGENT_USER_ID}`)
  console.log(`📋 ClickUp List ID: ${LIST_ID}`)
  console.log(`⏰ Cron дедлайны: каждый час`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log('Триггеры:')
  console.log('  1. Тег "prd" на задаче в ClickUp')
  console.log('  2. Статус "ready for pm agent"')
  console.log('  3. Комментарий "@pm-агент" в задаче')
  console.log('  4. POST /process { task_id: "..." }')
  console.log('')
})
