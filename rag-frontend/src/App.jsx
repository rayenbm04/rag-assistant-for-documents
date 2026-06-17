import { useState, useRef, useCallback, useEffect } from 'react'
import './App.css'

const API = import.meta.env.VITE_API_URL || "http://localhost:8000"

const UploadIcon = () => (
  <svg className="upload-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
  </svg>
)

const FileIcon = () => (
  <svg className="file-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
)

const RemoveIcon = () => (
  <svg className="file-remove" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
)

const ChatIcon = () => (
  <svg className="chat-empty-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </svg>
)

const SourceIcon = () => (
  <svg className="source-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
)

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function generateId() {
  return Math.random().toString(36).substring(2, 9)
}

function App() {
  const [question, setQuestion] = useState('')
  const [history, setHistory] = useState([])
  const [files, setFiles] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef(null)
  const chatEndRef = useRef(null)
  const abortControllerRef = useRef(null)
  const scrollTimerRef = useRef(null)
  const pendingIdRef = useRef(null)
  const isLoadingRef = useRef(false)
  const currentQuestionRef = useRef('')
  const pollingRef = useRef({})

  const scrollToBottom = useCallback(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  // load already-indexed documents on startup
  useEffect(() => {
    fetch(`${API}/documents`)
      .then(r => r.json())
      .then(docs => {
        setFiles(docs.map(d => ({
          id: d.id,
          name: d.name,
          size: 0,
          type: 'existing',
          status: d.status || 'ready'
        })))
      })
      .catch(() => {})
  }, [])

  // poll status for a file until it becomes ready or error
  const pollStatus = useCallback((filename) => {
    if (pollingRef.current[filename]) return

    pollingRef.current[filename] = setInterval(async () => {
      try {
        const res = await fetch(`${API}/status/${encodeURIComponent(filename)}`)
        const data = await res.json()

        if (data.status === 'ready' || data.status === 'error') {
          // stop polling
          clearInterval(pollingRef.current[filename])
          delete pollingRef.current[filename]

          // update file status in UI
          setFiles(prev => prev.map(f =>
            f.name === filename ? { ...f, status: data.status } : f
          ))
        }
      } catch (e) {
        clearInterval(pollingRef.current[filename])
        delete pollingRef.current[filename]
      }
    }, 2000) // poll every 2 seconds
  }, [])

  // cleanup polling on unmount
  useEffect(() => {
    return () => {
      Object.values(pollingRef.current).forEach(clearInterval)
    }
  }, [])

  const uploadToBackend = useCallback(async (file) => {
    const formData = new FormData()
    formData.append("file", file)
    const res = await fetch(`${API}/upload`, {
      method: "POST",
      body: formData
    })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    return await res.json()
  }, [])

  const handleFileSelect = useCallback(async (selectedFiles) => {
    const validFiles = Array.from(selectedFiles).filter(file =>
      file.type === 'application/pdf' || file.type.startsWith('image/')
    )

    for (const f of validFiles) {
      const tempId = generateId()

      // replace any existing entry with the same name, then add new one
      setFiles(prev => [...prev.filter(e => e.name !== f.name), {
        id: tempId,
        name: f.name,
        size: f.size,
        type: f.type,
        status: 'uploading'
      }])

      try {
        const result = await uploadToBackend(f)

        // update to "indexing" once uploaded
        setFiles(prev => prev.map(existing =>
          existing.id === tempId
            ? { ...existing, id: result.id, status: 'indexing' }
            : existing
        ))

        // start polling for ready status
        pollStatus(f.name)

      } catch (err) {
        setFiles(prev => prev.map(existing =>
          existing.id === tempId
            ? { ...existing, status: 'error' }
            : existing
        ))
      }
    }
  }, [uploadToBackend, pollStatus])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(false)
    handleFileSelect(e.dataTransfer.files)
  }, [handleFileSelect])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleRemoveFile = useCallback(async (id, filename) => {
    try {
      const res = await fetch(`${API}/documents/${encodeURIComponent(filename)}`, {
        method: "DELETE"
      })
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`)
      }
      setFiles(prev => prev.filter(f => f.id !== id))
    } catch (e) {
      console.error("Delete failed:", e)
      alert("Failed to delete the file from the server. It might be locked or busy.")
    }
  }, [])

const handleCancel = useCallback((e) => {
  if (e && e.preventDefault) e.preventDefault()
  console.log('[handleCancel] called, pendingIdRef:', pendingIdRef.current, 'isLoadingRef:', isLoadingRef.current)
  if (scrollTimerRef.current) {
    clearTimeout(scrollTimerRef.current)
    scrollTimerRef.current = null
  }
  const cancelledId = pendingIdRef.current
  pendingIdRef.current = null
  isLoadingRef.current = false
  if (cancelledId) {
    setHistory(prev => prev.filter(e => e.id !== cancelledId))
  }
  console.log('[handleCancel] calling setQuestion:', currentQuestionRef.current)
  setQuestion(currentQuestionRef.current)
  console.log('[handleCancel] calling setIsLoading(false)')
  setIsLoading(false)
  if (abortControllerRef.current) {
    abortControllerRef.current.abort()
    abortControllerRef.current = null
  }
  console.log('[handleCancel] done')
}, [])

const handleSubmit = useCallback(async (e) => {
  e.preventDefault()
  if (!question.trim() || isLoadingRef.current) return

  const currentQuestion = question.trim()
  currentQuestionRef.current = currentQuestion
  isLoadingRef.current = true
  setIsLoading(true)
  setQuestion('')   // clear immediately — disables Send, prevents double-submit
  setError(null)

  abortControllerRef.current = new AbortController()

  const tempId = generateId()
  pendingIdRef.current = tempId

  setHistory(prev => [...prev, {
    id: tempId,
    question: currentQuestion,
    answer: null,
    sources: [],
    warning: null
  }])
  scrollTimerRef.current = setTimeout(scrollToBottom, 100)

  try {
    const res = await fetch(`${API}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: currentQuestion }),
      signal: abortControllerRef.current.signal
    })

    // If cancelled while waiting, stop here
    if (!pendingIdRef.current) return

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.detail || `Server error: ${res.status}`)
    }

    const response = await res.json()

    // If cancelled while reading body, stop here
    if (!pendingIdRef.current) return

    setHistory(prev => prev.map(entry =>
      entry.id === tempId
        ? { ...entry, answer: response.answer.trim(), sources: response.sources || [], warning: response.warning || null }
        : entry
    ))
    // question already cleared at submit time
    scrollTimerRef.current = setTimeout(scrollToBottom, 100)

  } catch (err) {
    // If already cancelled by handleCancel, do nothing (UI already cleaned up)
    if (!pendingIdRef.current) return
    // Real error — restore question so user can retry
    setQuestion(currentQuestionRef.current)
    setHistory(prev => prev.map(entry =>
      entry.id === tempId
        ? { ...entry, answer: `Error: ${err.message}` }
        : entry
    ))
  } finally {
    if (pendingIdRef.current === tempId) {
      pendingIdRef.current = null
      isLoadingRef.current = false
      setIsLoading(false)
      abortControllerRef.current = null
    }
  }
}, [question, scrollToBottom])
  const getStatusBadge = (status) => {
  switch (status) {
    case 'uploading':  return { label: 'Uploading...', color: 'var(--text-muted)' }
    case 'indexing':   return { label: 'Indexing...', color: '#854F0B' }
    case 'ready':      return { label: 'Ready', color: '#3B6D11' }
    case 'error':      return { label: 'Error', color: '#e53e3e' }
    case 'cancelled':  return { label: 'Cancelled', color: 'var(--text-muted)' }
    default:           return null
  }
}
const handleCancelIndexing = useCallback(async (filename) => {
  try {
    await fetch(`${API}/cancel/${encodeURIComponent(filename)}`, {
      method: "POST"
    })
    // stop polling
    if (pollingRef.current[filename]) {
      clearInterval(pollingRef.current[filename])
      delete pollingRef.current[filename]
    }
    setFiles(prev => prev.filter(f => f.name !== filename))
  } catch (e) {
    console.error("Cancel failed:", e)
  }
}, [])

  const anyIndexing = files.some(f => f.status === 'indexing' || f.status === 'uploading')

  return (
    <div className="app">
      <nav className="navbar">
        <div className="navbar-logo">RAG Assistant</div>
        {anyIndexing && (
          <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            Indexing documents...
          </span>
        )}
      </nav>

      <div className="main-container">
        <aside className="sidebar">
          <h2 className="sidebar-title">Documents</h2>

          <div
            className={`upload-zone ${isDragOver ? 'dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <UploadIcon />
            <p className="upload-text">Click or drag to upload</p>
            <p className="upload-hint">PDF or images</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { handleFileSelect(e.target.files); e.target.value = '' }}
            />
          </div>

          {files.length > 0 && (
            <div className="file-list">
              {files.map(file => {
                const badge = getStatusBadge(file.status)
                return (
                  <div key={file.id} className="file-item">
                    <FileIcon />
                    <div className="file-info">
                      <div className="file-name">{file.name}</div>
                      <div className="file-size" style={{ color: badge?.color }}>
                        {badge ? badge.label : formatFileSize(file.size)}
                      </div>
                    </div>
                    {file.status === 'ready' && (
                     <div onClick={() => handleRemoveFile(file.id, file.name)} style={{ cursor: 'pointer' }}>
                      <RemoveIcon />
                      </div>
                    )}
                    {(file.status === 'indexing' || file.status === 'uploading') && (
  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
    <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
      {[0,1,2].map(i => (
        <div key={i} style={{
          width: '4px', height: '4px', borderRadius: '50%',
          background: 'var(--text-muted)',
          animation: `loading-pulse 1.2s infinite ${i * 0.2}s`
        }} />
      ))}
    </div>
    {file.status === 'indexing' && (
      <span
        onClick={() => handleCancelIndexing(file.name)}
        style={{
          fontSize: '11px', color: '#854F0B',
          cursor: 'pointer', textDecoration: 'underline'
        }}
      >
        cancel
      </span>
    )}
  </div>
)}
                  </div>
                )
              })}
            </div>
          )}
        </aside>

        <main className="chat-area">
          <div className="chat-messages">
            {history.length === 0 && !isLoading && (
              <div className="chat-empty">
                <ChatIcon />
                <h3 className="chat-empty-title">Start a conversation</h3>
                <p className="chat-empty-text">
                  Upload documents and ask questions to get answers with source citations.
                </p>
              </div>
            )}

            {history.map(entry => (
              <div key={entry.id} className="conversation-entry">

                {/* user question */}
                <div className="message-wrapper user">
                  <div className="message user">
                    <p className="message-content">{entry.question}</p>
                  </div>
                </div>

                {/* AI answer */}
                <div className="message-wrapper ai">
                  <div className="message ai">
                    {entry.answer === null ? (
                      <div className="loading-dots">
                        <div className="loading-dot" />
                        <div className="loading-dot" />
                        <div className="loading-dot" />
                      </div>
                    ) : (
                      <p className="message-content">{entry.answer}</p>
                    )}
                  </div>

                  {/* warning — files still indexing */}
                  {entry.warning && (
                    <p style={{
                      fontSize: '12px', color: '#854F0B',
                      margin: '6px 0 0', padding: '6px 10px',
                      background: '#FAEEDA', borderRadius: '6px'
                    }}>
                      ⚠ {entry.warning}
                    </p>
                  )}

                  {/* sources */}
                  {entry.sources && entry.sources.length > 0 && entry.answer !== null && (
                    <div className="sources">
                      {entry.sources.map((source, idx) => (
                        <span key={idx} className="source-pill">
                          <SourceIcon />
                          {source}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

              </div>
            ))}

            <div ref={chatEndRef} />
          </div>

          <form className="input-bar" onSubmit={handleSubmit}>
            <div className="input-container">
              <input
                type="text"
                className="input-field"
                placeholder="Ask a question about your documents..."
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={isLoading}
              />
    {isLoading ? (
      <button
        key="cancel-btn"
        type="button"
        className="cancel-button"
        onClick={handleCancel}
      >
        Cancel
      </button>
    ) : (
      <button
        key="send-btn"
        type="submit"
        className="send-button"
        disabled={!question.trim()}
      >
        Send
      </button>
    )}
  </div>
</form>
        </main>
      </div>
    </div>
  )
}

export default App
