import xml.etree.ElementTree as ET
from typing import Any, Dict, List

from models.SpatialLocation import SpatialLocation
from models.TemporalInterval import TemporalInterval
from pydantic.main import BaseModel

# =============================================================================
# FactIntersection
# =============================================================================


class FactIntersection(BaseModel):

    data: str = ''
    namespace: Dict[str, str] = {}
    accessPolicy: str = ''
    deliveryModality: str = ''  # orn
    runs: str = ''
    language: str = ''
    isExclusive: str = ''
    constraintList = ['copyrightExceptionFact', 'accessPolicy', 'deliveryModality', 'device', 'means', 'serviceAccessPolicy', 'userTimeAccess', 'temporalInterval',
                      'spatialLocation', 'runs', 'language', 'hasIncomePercentage', 'hasUsePercentage', 'isExclusive', 'hasSublicenseRight', 'length', 'IPEntityContext']
    spatialLocation: str = ''
    means: List[str] = []

    def parse(self):
        constraint = ET.fromstring(self.data)
        t = constraint.find('cel-ipre:temporalInterval', self.namespace)
        if t is not None:  # DMAF: Element truthiness is len(children)
            time1 = TemporalInterval(
                **{'data': ET.tostring(t), 'namespace': self.namespace})
            time1.parse()
            self.time.append(time1.afterDate)
            self.time.append(time1.beforeDate)

        accessPolicy = constraint.find('cel-ipre:AccessPolicy', self.namespace)
        if accessPolicy is not None:  # DMAF: Element truthiness is len(children)
            attrib = accessPolicy.attrib
            if 'access' in attrib:
                self.accessPolicy = accessPolicy.attrib['access']

        deliveryModality = constraint.find(
            'cel-ipre:DeliveryModality', self.namespace)
        if deliveryModality is not None:  # DMAF: Element truthiness is len(children)
            attrib = deliveryModality.attrib
            if 'mod' in attrib:
                self.deliveryModality = deliveryModality.attrib['mod']
            if 'href' in attrib:
                self.deliveryModality = deliveryModality.attrib['href']

        runs = constraint.find('cel-ipre:Runs', self.namespace)
        if runs is not None:  # DMAF: Element truthiness is len(children)
            attrib = runs.attrib
            if 'number' in runs:
                self.runs = runs.attrib['number']

        language = constraint.find('cel-ipre:Language', self.namespace)
        if language is not None:  # DMAF: Element truthiness is len(children)
            attrib = language.attrib
            if 'lang' in attrib:
                self.language = language.attrib['lang']

        isExclusive = constraint.find('cel-ipre:isExclusive', self.namespace)
        if isExclusive is not None:  # DMAF: Element truthiness is len(children)
            attrib = isExclusive.attrib
            if 'value' in attrib:
                self.isExclusive = isExclusive.attrib['value']

        means = constraint.findall('cel-ipre:Means', self.namespace)
        m = []
        for i in means:
            attrib = i.attrib
            if 'tec' in attrib:
                m.append(i.attrib['tec'])
        self.means = m

        spatialLocation = constraint.find(
            'cel-ipre:spatialLocation', self.namespace)
        if spatialLocation is not None:  # DMAF: Element truthiness is len(children)
            location = SpatialLocation(
                **{'data': ET.tostring(spatialLocation), 'namespace': self.namespace})
            location.parse()
            self.spatialLocation = location.places
        self.namespace = None
        self.data = None
