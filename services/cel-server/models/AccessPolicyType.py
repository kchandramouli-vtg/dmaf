from typing import Any, Dict
import xml.etree.ElementTree as ET
from pydantic.main import BaseModel


class AccessPolicyType(BaseModel):
    data: str = ''
    namespace: Dict[str, str] = {}
    access: str = ''

    def parse(self):
        AccessPolicyType = ET.fromstring(self.data)
        access = AccessPolicyType.find('cel-ipre:AccessType', self.namespace)
        if access is not None:  # DMAF: Element truthiness is len(children)
            self.access = access.text
        self.namespace = None
        self.data = None
