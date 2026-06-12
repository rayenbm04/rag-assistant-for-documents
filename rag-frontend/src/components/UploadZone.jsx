const UploadZone = ({ onFileChange, files }) => {
  return (
    <div className="upload-zone"
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); onFileChange(e.dataTransfer.files) }}
    >
      <p>Drop your PDF or image here, or choose files</p>
      <input
        type="file"
        accept=".pdf,image/*"
        multiple
        onChange={e => { onFileChange(e.target.files); e.target.value = '' }}
      />
      {files.length > 0 && (
        <div style={{ marginTop: "12px" }}>
          {Array.from(files).map((f, idx) => (
            <div key={idx} className="file-item">
              <span className="file-name">{f.name}</span>
              <span className={`file-badge ${f.type.includes('pdf') ? 'badge-pdf' : 'badge-image'}`}>
                {f.type.includes('pdf') ? 'PDF' : 'IMG'}
              </span>
              <span className="file-size">{(f.size / 1024).toFixed(1)} KB</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default UploadZone