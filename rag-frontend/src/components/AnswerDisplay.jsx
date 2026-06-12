const AnswerDisplay = ({ history }) => {
  if (!history.length) return null

  return (
    <div className="history-section">
      <h3>Conversation</h3>
      {history.map(entry => (
        <div key={entry.id} className="history-entry">

          {/* question bubble */}
          <div className="bubble-question">
            <span className="bubble-label">You</span>
            <p>{entry.question}</p>
          </div>

          {/* answer bubble */}
          <div className="bubble-answer">
            <span className="bubble-label">RAG Assistant</span>
            <p>{entry.answer}</p>
            {entry.sources.length > 0 && (
              <div className="sources-list">
                <span className="sources-label">Sources</span>
                {entry.sources.map(s => (
                  <div key={s} className="source-item">{s}</div>
                ))}
              </div>
            )}
          </div>

        </div>
      ))}
    </div>
  )
}

export default AnswerDisplay