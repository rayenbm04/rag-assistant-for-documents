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

# llama_index — stub every submodule main.py imports from
_stub("llama_index")

# llama_index.core and its subpackages
_stub("llama_index.core")
_stub("llama_index.core.storage")
_stub("llama_index.core.storage.storage_context")
_stub("llama_index.core.storage.docstore")
_stub("llama_index.core.vector_stores")
_stub("llama_index.core.vector_stores.types")
_stub("llama_index.core.retrievers")
_stub("llama_index.core.schema")
_stub("llama_index.core.node_parser")

# llama_index.retrievers (separate namespace from core)
_stub("llama_index.retrievers")
_stub("llama_index.retrievers.bm25")

# llama_index.vector_stores / llms / embeddings
_stub("llama_index.vector_stores")
_stub("llama_index.vector_stores.chroma")
_stub("llama_index.llms")
_stub("llama_index.llms.ollama")
_stub("llama_index.embeddings")
_stub("llama_index.embeddings.ollama")

# Provide the classes main.py imports from llama_index.core
settings_mock = MagicMock()
sys.modules["llama_index.core"].Settings = settings_mock
sys.modules["llama_index.core"].VectorStoreIndex = MagicMock()
sys.modules["llama_index.core"].Document = MagicMock()
sys.modules["llama_index.core"].PromptTemplate = MagicMock(side_effect=lambda t: t)

# llama_index.core.vector_stores.types
types_mod = sys.modules["llama_index.core.vector_stores.types"]
types_mod.MetadataFilters = MagicMock()
types_mod.MetadataFilter = MagicMock()
types_mod.FilterOperator = MagicMock()
types_mod.FilterCondition = MagicMock()

# llama_index.core.retrievers
retrievers_mod = sys.modules["llama_index.core.retrievers"]
retrievers_mod.QueryFusionRetriever = MagicMock()
retrievers_mod.AutoMergingRetriever = MagicMock()

# llama_index.core.schema
sys.modules["llama_index.core.schema"].TextNode = MagicMock()

# llama_index.retrievers.bm25
sys.modules["llama_index.retrievers.bm25"].BM25Retriever = MagicMock()

# llama_index.core.storage.*
sys.modules["llama_index.core.storage.storage_context"].StorageContext = MagicMock()
sys.modules["llama_index.core.storage.docstore"].SimpleDocumentStore = MagicMock()

# llama_index.core.node_parser
node_parser_mod = sys.modules["llama_index.core.node_parser"]
node_parser_mod.HierarchicalNodeParser = MagicMock()
node_parser_mod.get_leaf_nodes = MagicMock(return_value=[])

# llama_index.vector_stores / llms / embeddings
sys.modules["llama_index.vector_stores.chroma"].ChromaVectorStore = MagicMock()
sys.modules["llama_index.llms.ollama"].Ollama = MagicMock()
sys.modules["llama_index.embeddings.ollama"].OllamaEmbedding = MagicMock()

# ollama
_stub("ollama")

# pdfplumber
_stub("pdfplumber")

# PIL / Pillow
_stub("PIL")
_stub("PIL.Image")

# beautifulsoup4 / requests / pptx — only needed at call time, but stub to be safe
_stub("bs4")
_stub("pptx")
_stub("pptx.util")
