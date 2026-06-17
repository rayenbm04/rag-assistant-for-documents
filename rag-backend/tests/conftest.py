"""
Conftest — stubs out all heavy external dependencies (chromadb, llama_index,
ollama) so tests run without Ollama or ChromaDB installed.
"""

import sys
from unittest.mock import MagicMock


def _stub(name, **attrs):
    m = MagicMock()
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


# chromadb
chroma_collection_mock = MagicMock()
chroma_collection_mock.count.return_value = 0
chroma_collection_mock.get.return_value = {"ids": [], "documents": [], "metadatas": []}

chroma_client_mock = MagicMock()
chroma_client_mock.get_or_create_collection.return_value = chroma_collection_mock

chromadb_mod = _stub("chromadb")
chromadb_mod.PersistentClient.return_value = chroma_client_mock

# llama_index family
_stub("llama_index")
_stub("llama_index.core")
_stub("llama_index.core.storage")
_stub("llama_index.core.storage.storage_context")
_stub("llama_index.vector_stores")
_stub("llama_index.vector_stores.chroma")
_stub("llama_index.llms")
_stub("llama_index.llms.ollama")
_stub("llama_index.embeddings")
_stub("llama_index.embeddings.ollama")

# Provide the classes main.py imports
settings_mock = MagicMock()
sys.modules["llama_index.core"].Settings = settings_mock
sys.modules["llama_index.core"].VectorStoreIndex = MagicMock()
sys.modules["llama_index.core"].Document = MagicMock()
sys.modules["llama_index.core"].PromptTemplate = MagicMock(side_effect=lambda t: t)
sys.modules["llama_index.core.storage.storage_context"].StorageContext = MagicMock()
sys.modules["llama_index.vector_stores.chroma"].ChromaVectorStore = MagicMock()
sys.modules["llama_index.llms.ollama"].Ollama = MagicMock()
sys.modules["llama_index.embeddings.ollama"].OllamaEmbedding = MagicMock()

# ollama
_stub("ollama")

# pdfplumber
_stub("pdfplumber")

# PIL / Pillow
pil_image_mod = _stub("PIL")
_stub("PIL.Image")
