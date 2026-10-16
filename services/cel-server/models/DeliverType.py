from typing import Any, Dict
import xml.etree.ElementTree as ET
from pydantic.main import BaseModel
# =============================================================================
# DeliverType
# =============================================================================


class DeliverType(BaseModel):
    data: str = ''
    namespace: Dict[str, str] = {}
    mod: str = ''

    def parse(self):
        DeliverType = ET.fromstring(self.data)
        mod = DeliverType.find('cel-ipre:ModalityType', self.namespace)
        if mod is not None:  # DMAF: Element truthiness is len(children)
            self.mod = mod.text
        self.namespace = None
        self.data = None
